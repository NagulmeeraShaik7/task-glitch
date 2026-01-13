import { useCallback, useEffect, useMemo, useState } from 'react';
import { DerivedTask, Metrics, Task } from '@/types';
import {
  computeAverageROI,
  computePerformanceGrade,
  computeRevenuePerHour,
  computeTimeEfficiency,
  computeTotalRevenue,
  withDerived,
  sortTasks as sortDerived,
} from '@/utils/logic';
import { generateSalesTasks } from '@/utils/seed';

/* 🔐 Survives StrictMode remounts and HMR */
// Use a cached Promise to make fetch idempotent across mounts and HMR
let tasksFetchPromise: Promise<any[]> | null = null;

interface UseTasksState {
  tasks: Task[];
  loading: boolean;
  error: string | null;
  derivedSorted: DerivedTask[];
  metrics: Metrics;
  lastDeleted: Task | null;
  lastDeletedToken: string | null;
  addTask: (task: Omit<Task, 'id' | 'createdAt'> & { id?: string }) => void;
  updateTask: (id: string, patch: Partial<Task>) => void;
  deleteTask: (id: string) => void;
  undoDelete: (token?: string) => void;
  clearLastDeleted: (token?: string) => void;
}

const INITIAL_METRICS: Metrics = {
  totalRevenue: 0,
  totalTimeTaken: 0,
  timeEfficiencyPct: 0,
  revenuePerHour: 0,
  averageROI: 0,
  performanceGrade: 'Needs Improvement',
};

export function useTasks(): UseTasksState {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastDeleted, setLastDeleted] = useState<Task | null>(null);
  // Token identifies the current deletion window to avoid races when multiple deletions happen quickly
  const [lastDeletedToken, setLastDeletedToken] = useState<string | null>(null);

  function normalizeTasks(input: any[]): Task[] {
    const now = Date.now();
    return (Array.isArray(input) ? input : []).map((t, idx) => {
      const created = t.createdAt
        ? new Date(t.createdAt)
        : new Date(now - (idx + 1) * 24 * 3600 * 1000);
      const completed =
        t.completedAt ||
        (t.status === 'Done'
          ? new Date(created.getTime() + 24 * 3600 * 1000).toISOString()
          : undefined);

      return {
        id: t.id ?? crypto.randomUUID(),
        title: t.title || 'Untitled',
        revenue: Number.isFinite(Number(t.revenue)) ? Number(t.revenue) : 0,
        timeTaken: Number(t.timeTaken) > 0 ? Number(t.timeTaken) : 1,
        priority: t.priority || 'Low',
        status: t.status || 'Todo',
        notes: t.notes || '',
        createdAt: created.toISOString(),
        completedAt: completed,
      };
    });
  }

  /* =========================
     ✅ FIXED SINGLE FETCH
     ========================= */
  useEffect(() => {
    // Use a cached Promise so even if this effect runs multiple times
    // (StrictMode remount, HMR, etc.), only one real network request happens.
    if (!tasksFetchPromise) {
      tasksFetchPromise = (async () => {
        console.debug('[useTasks] fetch tasks – starting network request');
        try {
          const res = await fetch('/tasks.json');
          if (!res.ok) throw new Error(`Failed to load tasks.json (${res.status})`);
          const data = (await res.json()) as any[];
          const normalized = normalizeTasks(data);
          return normalized.length > 0 ? normalized : generateSalesTasks(50);
        } catch (e) {
          console.error('[useTasks] fetch tasks failed', e);
          // Reset the promise so future tries can attempt again
          tasksFetchPromise = null;
          throw e;
        }
      })();
    }

    let isMounted = true;
    (async () => {
      try {
        const finalData = await tasksFetchPromise;
        if (isMounted) setTasks(finalData);
      } catch (e: any) {
        if (isMounted) setError(e?.message ?? 'Failed to load tasks');
      } finally {
        if (isMounted) setLoading(false);
      }
    })();

    return () => {
      isMounted = false;
    };
  }, []);

  const derivedSorted = useMemo<DerivedTask[]>(() => {
    const withRoi = tasks.map(withDerived);
    return sortDerived(withRoi);
  }, [tasks]);

  const metrics = useMemo<Metrics>(() => {
    if (tasks.length === 0) return INITIAL_METRICS;
    const totalRevenue = computeTotalRevenue(tasks);
    const totalTimeTaken = tasks.reduce((s, t) => s + t.timeTaken, 0);
    const timeEfficiencyPct = computeTimeEfficiency(tasks);
    const revenuePerHour = computeRevenuePerHour(tasks);
    const averageROI = computeAverageROI(tasks);
    const performanceGrade = computePerformanceGrade(averageROI);
    return {
      totalRevenue,
      totalTimeTaken,
      timeEfficiencyPct,
      revenuePerHour,
      averageROI,
      performanceGrade,
    };
  }, [tasks]);

  const addTask = useCallback((task: Omit<Task, 'id' | 'createdAt'> & { id?: string }) => {
    setTasks(prev => {
      const id = task.id ?? crypto.randomUUID();
      const timeTaken = task.timeTaken <= 0 ? 1 : task.timeTaken;
      const createdAt = new Date().toISOString();
      const completedAt = task.status === 'Done' ? createdAt : undefined;
      return [...prev, { ...task as Omit<Task, 'id'>, id, timeTaken, createdAt, completedAt }];
    });
  }, []);

  const updateTask = useCallback((id: string, patch: Partial<Task>) => {
    setTasks(prev =>
      prev.map(t => {
        if (t.id !== id) return t;
        const merged = { ...t, ...patch };
        if (t.status !== 'Done' && merged.status === 'Done' && !merged.completedAt) {
          merged.completedAt = new Date().toISOString();
        }
        if (merged.timeTaken <= 0) merged.timeTaken = 1;
        return merged;
      }),
    );
  }, []);

  const deleteTask = useCallback((id: string) => {
    setTasks(prev => {
      const target = prev.find(t => t.id === id) || null;
      if (target) console.debug('[useTasks] deleteTask - lastDeleted set to', target.id);
      const token = (typeof crypto !== 'undefined' && 'randomUUID' in crypto) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      setLastDeleted(target);
      setLastDeletedToken(token);
      return prev.filter(t => t.id !== id);
    });
  }, []);

  const undoDelete = useCallback((token?: string) => {
    // Only restore if token matches current deletion window (prevents stale restores)
    if (!lastDeleted) return;
    if (token && token !== lastDeletedToken) {
      console.debug('[useTasks] undoDelete - token mismatch, abort restore', token, lastDeletedToken);
      return;
    }
    console.debug('[useTasks] undoDelete - restoring', lastDeleted.id);
    setTasks(prev => [...prev, lastDeleted]);
    setLastDeleted(null);
    setLastDeletedToken(null);
  }, [lastDeleted, lastDeletedToken]);

  const clearLastDeleted = useCallback((token?: string) => {
    // Only clear if token matches or no token supplied. This prevents earlier
    // close handlers from clearing a more recent deletion (race safety).
    if (token && token !== lastDeletedToken) {
      console.debug('[useTasks] clearLastDeleted - token mismatch, ignoring', token, lastDeletedToken);
      return;
    }
    console.debug('[useTasks] clearLastDeleted');
    setLastDeleted(null);
    setLastDeletedToken(null);
  }, [lastDeletedToken]);

  return {
    tasks,
    loading,
    error,
    derivedSorted,
    metrics,
    lastDeleted,
    lastDeletedToken,
    addTask,
    updateTask,
    deleteTask,
    undoDelete,
    clearLastDeleted,
  };
}

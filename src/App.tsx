import { useEffect, useState, useMemo, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  getCurrentWindow,
  LogicalSize,
  LogicalPosition,
  availableMonitors,
} from '@tauri-apps/api/window';
import { AppProvider } from '@/context/AppContext';
import { useAppContext } from '@/context/useAppContext';
import { useWindowOpacity } from '@/hooks/useWindowOpacity';
import { useWindowDrag } from '@/hooks/useWindowDrag';
import { Header } from '@/components/Header';
import { MinimumView } from '@/components/MinimumView';
import { SessionList } from '@/components/SessionList';
import { SetupModal } from '@/components/SetupModal';
import { TmuxViewer } from '@/components/TmuxViewer';
import { Workspaces } from '@/components/Workspaces';
import {
  onWindowFocus,
  bringDiffWindowsToFront,
  getSetupStatus,
  setWindowSizeForSetup,
} from '@/lib/tauri';
import { allHooksConfigured } from '@/lib/utils';
import type { SetupStatus } from '@/types';

const MINIMUM_VIEW_HEIGHT = 50;
const MINIMUM_VIEW_WIDTH = 240;
const SAVED_WINDOW_STATE_KEY = 'eocc_saved_window_state';

interface SavedWindowState {
  width: number;
  height: number;
  x: number;
  y: number;
}

function loadSavedWindowState(): SavedWindowState | null {
  try {
    const stored = localStorage.getItem(SAVED_WINDOW_STATE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    if (
      typeof parsed.width === 'number' &&
      typeof parsed.height === 'number' &&
      typeof parsed.x === 'number' &&
      typeof parsed.y === 'number'
    ) {
      return parsed as SavedWindowState;
    }
    return null;
  } catch {
    return null;
  }
}

function saveSavedWindowState(state: SavedWindowState): void {
  try {
    localStorage.setItem(SAVED_WINDOW_STATE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage errors
  }
}

function clearSavedWindowState(): void {
  try {
    localStorage.removeItem(SAVED_WINDOW_STATE_KEY);
  } catch {
    // Ignore storage errors
  }
}

async function clampPositionToScreen(
  x: number,
  y: number,
  width: number,
  height: number
): Promise<{ x: number; y: number }> {
  try {
    const monitors = await availableMonitors();
    if (monitors.length === 0) return { x, y };

    // Find monitor that contains the point, or use first monitor
    let targetMonitor = monitors.find((m) => {
      const mx = m.position.x;
      const my = m.position.y;
      const mw = m.size.width;
      const mh = m.size.height;
      return x >= mx && x < mx + mw && y >= my && y < my + mh;
    });

    if (!targetMonitor) {
      targetMonitor = monitors[0];
    }

    const mx = targetMonitor.position.x;
    const my = targetMonitor.position.y;
    const mw = targetMonitor.size.width;
    const mh = targetMonitor.size.height;

    // Clamp position to keep window within monitor bounds
    const clampedX = Math.max(mx, Math.min(x, mx + mw - width));
    const clampedY = Math.max(my, Math.min(y, my + mh - height));

    return { x: clampedX, y: clampedY };
  } catch {
    return { x, y };
  }
}

const DEBOUNCE_MS = 150;

type TabType = 'sessions' | 'workspaces';

const Dashboard = () => {
  const { dashboardData, settings, isLoading, refreshData } = useAppContext();
  const [isActive, setIsActive] = useState(true);
  const [activeTab, setActiveTab] = useState<TabType>('sessions');
  const savedStateRef = useRef<SavedWindowState | null>(loadSavedWindowState());
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Always apply mini-view class to body
  useEffect(() => {
    document.body.classList.add('mini-view');
    return () => {
      document.body.classList.remove('mini-view');
    };
  }, []);

  // Track window active state for minimum mode (with debounce)
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let mounted = true;

    const debouncedSetActive = (active: boolean) => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        if (mounted) setIsActive(active);
      }, DEBOUNCE_MS);
    };

    const setup = async () => {
      try {
        // Set initial state (no debounce for initial)
        const focused = await getCurrentWindow().isFocused();
        if (mounted) setIsActive(focused);

        // Listen for dashboard-active event
        const u = await listen<boolean>('dashboard-active', (event) => {
          if (mounted) debouncedSetActive(event.payload);
        });

        if (mounted) {
          unlisten = u;
        } else {
          u();
        }
      } catch (error) {
        console.error('Failed to setup window active state tracking:', error);
      }
    };

    setup();

    return () => {
      mounted = false;
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      unlisten?.();
    };
  }, []);

  // Resize window based on active state (only when minimum mode is enabled)
  useEffect(() => {
    const window = getCurrentWindow();

    const resizeWindow = async () => {
      const scaleFactor = await window.scaleFactor();

      // When minimum mode is disabled, restore window if it was shrunk
      if (!settings.minimum_mode_enabled) {
        const saved = savedStateRef.current;
        if (saved) {
          const clamped = await clampPositionToScreen(saved.x, saved.y, saved.width, saved.height);
          await window.setSize(new LogicalSize(saved.width, saved.height));
          await window.setPosition(new LogicalPosition(clamped.x, clamped.y));
          savedStateRef.current = null;
          clearSavedWindowState();
        }
        return;
      }

      if (isActive) {
        // Restore to previous size and position
        const saved = savedStateRef.current;
        if (saved) {
          const clamped = await clampPositionToScreen(saved.x, saved.y, saved.width, saved.height);
          await window.setSize(new LogicalSize(saved.width, saved.height));
          await window.setPosition(new LogicalPosition(clamped.x, clamped.y));
          savedStateRef.current = null;
          clearSavedWindowState();
        }
      } else {
        // Save current size and position before minimizing
        const [physicalSize, physicalPosition] = await Promise.all([
          window.innerSize(),
          window.outerPosition(),
        ]);

        // Convert physical to logical pixels
        const state: SavedWindowState = {
          width: physicalSize.width / scaleFactor,
          height: physicalSize.height / scaleFactor,
          x: physicalPosition.x / scaleFactor,
          y: physicalPosition.y / scaleFactor,
        };
        savedStateRef.current = state;
        saveSavedWindowState(state);

        await window.setSize(new LogicalSize(MINIMUM_VIEW_WIDTH, MINIMUM_VIEW_HEIGHT));
      }
    };

    resizeWindow().catch(console.error);
  }, [isActive, settings.minimum_mode_enabled]);

  // Handle window opacity based on focus
  useWindowOpacity(settings.opacity_active, settings.opacity_inactive);

  // Handle window drag
  useWindowDrag();

  // Bring diff windows to front when dashboard is focused (via Cmd+Tab etc.)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let mounted = true;

    onWindowFocus(() => {
      bringDiffWindowsToFront().catch(console.error);
    })
      .then((u) => {
        if (mounted) {
          unlisten = u;
        } else {
          u();
        }
      })
      .catch(console.error);

    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  if (isLoading) {
    return (
      <div className="container bg-bg-primary h-screen rounded-xl max-w-[900px] mx-auto p-2.5 flex items-center justify-center">
        <div className="text-text-secondary">Loading...</div>
      </div>
    );
  }

  // Show minimum view when inactive and minimum mode is enabled
  if (!isActive && settings.minimum_mode_enabled) {
    return <MinimumView sessions={dashboardData.sessions} />;
  }

  return (
    <div className="container bg-bg-primary h-screen rounded-xl max-w-[900px] mx-auto flex flex-col p-2.5">
      <Header sessions={dashboardData.sessions} onRefresh={refreshData} />
      <div className="flex gap-1 mb-2">
        <button
          onClick={() => setActiveTab('sessions')}
          className={`px-2 py-1 text-[0.625rem] rounded transition-colors ${
            activeTab === 'sessions'
              ? 'bg-accent-purple text-white'
              : 'bg-bg-secondary text-text-secondary hover:text-text-primary'
          }`}
        >
          Sessions
        </button>
        <button
          onClick={() => setActiveTab('workspaces')}
          className={`px-2 py-1 text-[0.625rem] rounded transition-colors ${
            activeTab === 'workspaces'
              ? 'bg-accent-purple text-white'
              : 'bg-bg-secondary text-text-secondary hover:text-text-primary'
          }`}
        >
          Workspaces
        </button>
      </div>
      {activeTab === 'sessions' ? (
        <SessionList sessions={dashboardData.sessions} />
      ) : (
        <Workspaces />
      )}
    </div>
  );
};

function App() {
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [showSetupModal, setShowSetupModal] = useState(false);
  const [setupChecked, setSetupChecked] = useState(false);

  // Parse URL parameters to check if this is a tmux viewer window
  const tmuxPaneId = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('tmux_pane');
  }, []);

  // Check setup status on mount (skip for tmux viewer windows)
  useEffect(() => {
    // Skip for tmux viewer windows - they render before this check
    if (tmuxPaneId) return;

    getSetupStatus()
      .then((status) => {
        setSetupStatus(status);
        // Show modal if any hook is missing or there's an init error
        if (!allHooksConfigured(status.hooks) || status.init_error) {
          setShowSetupModal(true);
          // Enlarge window for setup modal
          setWindowSizeForSetup(true).catch(console.error);
        }
        setSetupChecked(true);
      })
      .catch((err) => {
        console.error('Failed to get setup status:', err);
        setSetupChecked(true);
      });
  }, [tmuxPaneId]);

  const handleSetupComplete = () => {
    setShowSetupModal(false);
    // Restore miniview size
    setWindowSizeForSetup(false).catch(console.error);
  };

  // Render tmux viewer if pane_id is in URL
  if (tmuxPaneId) {
    return <TmuxViewer paneId={tmuxPaneId} />;
  }

  // Wait for setup check before showing anything
  if (!setupChecked) {
    return (
      <div className="bg-bg-primary h-screen flex items-center justify-center">
        <div className="text-text-secondary">Checking setup...</div>
      </div>
    );
  }

  return (
    <AppProvider>
      <Dashboard />
      {showSetupModal && setupStatus && (
        <SetupModal setupStatus={setupStatus} onComplete={handleSetupComplete} />
      )}
    </AppProvider>
  );
}

export default App;

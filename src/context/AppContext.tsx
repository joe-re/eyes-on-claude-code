import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import type { DashboardData, Settings, SessionInfo } from '@/types';
import { getDashboardData, getSettings, onStateUpdated, onSettingsUpdated } from '@/lib/tauri';
import { playCompletionSound, playWaitingSound } from '@/lib/audio';
import { AppContext, defaultDashboardData, defaultSettings } from './appContextStore';

export const AppProvider = ({ children }: { children: ReactNode }) => {
  const [dashboardData, setDashboardData] = useState<DashboardData>(defaultDashboardData);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [isLoading, setIsLoading] = useState(true);
  const previousStatesRef = useRef<Map<string, string>>(new Map());
  const soundEnabledRef = useRef(true);

  // Keep soundEnabledRef in sync with settings
  useEffect(() => {
    soundEnabledRef.current = settings.sound_enabled;
  }, [settings.sound_enabled]);

  const checkAndPlaySounds = useCallback((sessions: SessionInfo[]) => {
    if (!soundEnabledRef.current) return;

    const getSessionKey = (s: SessionInfo) => {
      const base = s.project_dir || s.project_name;
      return s.tmux_pane ? `${base}:${s.tmux_pane}` : base;
    };

    for (const session of sessions) {
      const key = getSessionKey(session);
      const prevStatus = previousStatesRef.current.get(key);
      const currentStatus = session.status;

      if (prevStatus !== currentStatus) {
        if (currentStatus === 'Completed') {
          playCompletionSound();
        } else if (currentStatus === 'WaitingPermission' || currentStatus === 'WaitingInput') {
          playWaitingSound();
        }
      }
      previousStatesRef.current.set(key, currentStatus);
    }

    // Cleanup old sessions
    const currentKeys = new Set(sessions.map(getSessionKey));
    for (const key of previousStatesRef.current.keys()) {
      if (!currentKeys.has(key)) {
        previousStatesRef.current.delete(key);
      }
    }
  }, []);

  const refreshData = useCallback(async () => {
    try {
      const data = await getDashboardData();
      setDashboardData(data);
    } catch (error) {
      console.error('Failed to fetch data:', error);
    }
  }, []);

  // Initial load
  useEffect(() => {
    const init = async () => {
      try {
        const [data, loadedSettings] = await Promise.all([getDashboardData(), getSettings()]);
        setDashboardData(data);
        setSettings(loadedSettings);
      } catch (error) {
        console.error('Failed to initialize:', error);
      } finally {
        setIsLoading(false);
      }
    };
    init();
  }, []);

  // Tauri event listeners
  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    onStateUpdated((data) => {
      checkAndPlaySounds(data.sessions);
      setDashboardData(data);
    }).then((unlisten) => unlisteners.push(unlisten));

    onSettingsUpdated((newSettings) => {
      setSettings(newSettings);
    }).then((unlisten) => unlisteners.push(unlisten));

    return () => {
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [checkAndPlaySounds]);

  // Auto-refresh backup
  useEffect(() => {
    const interval = setInterval(refreshData, 5000);
    return () => clearInterval(interval);
  }, [refreshData]);

  return (
    <AppContext.Provider value={{ dashboardData, settings, isLoading, refreshData }}>
      {children}
    </AppContext.Provider>
  );
};

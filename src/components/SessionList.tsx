import { useMemo } from 'react';
import type { SessionInfo } from '@/types';
import { SessionCard } from './SessionCard';
import { EmptyState } from './EmptyState';

interface SessionListProps {
  sessions: SessionInfo[];
  searchQuery: string;
}

export const SessionList = ({ sessions, searchQuery }: SessionListProps) => {
  const tmuxSessions = sessions.filter((session) => session.tmux_pane);

  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return tmuxSessions;

    const query = searchQuery.toLowerCase();
    return tmuxSessions.filter((session) => {
      const name = session.custom_name || session.project_name || '';
      const dir = session.project_dir || '';
      return (
        name.toLowerCase().includes(query) ||
        dir.toLowerCase().includes(query)
      );
    });
  }, [tmuxSessions, searchQuery]);

  return (
    <div className="flex-1 overflow-y-scroll min-h-0">
      <div className="flex flex-col gap-2">
        {filteredSessions.length === 0 ? (
          <EmptyState
            icon={searchQuery ? '🔍' : '📭'}
            message={searchQuery ? 'No matching sessions' : 'No active sessions'}
          />
        ) : (
          filteredSessions.map((session) => {
            const projectKey = session.project_dir || session.project_name;
            const sessionKey = `${projectKey}:${session.tmux_pane}`;
            return <SessionCard key={sessionKey} session={session} />;
          })
        )}
      </div>
    </div>
  );
};

import type { SessionInfo } from '@/types';
import { SessionCard } from './SessionCard';
import { EmptyState } from './EmptyState';

interface SessionListProps {
  sessions: SessionInfo[];
}

export const SessionList = ({ sessions }: SessionListProps) => {
  const tmuxSessions = sessions.filter((session) => session.tmux_pane);

  return (
    <div className="flex-1 overflow-y-scroll min-h-0">
      <div className="flex flex-col gap-2">
        {tmuxSessions.length === 0 ? (
          <EmptyState icon="📭" message="No active sessions" />
        ) : (
          tmuxSessions.map((session) => {
            const projectKey = session.project_dir || session.project_name;
            const sessionKey = `${projectKey}:${session.tmux_pane}`;
            return <SessionCard key={sessionKey} session={session} />;
          })
        )}
      </div>
    </div>
  );
};

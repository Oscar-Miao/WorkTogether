import { useEffect, useState } from 'react';
import type { AccountOverview } from '@team-agent/contracts';
import { Modal } from '../../components/ui.js';
import { platform } from '../../lib/platform-api.js';
import { projectId } from '../../lib/project-scope.js';
import { TeamWelcome } from './TeamWelcome.js';
import { TeamInvitations } from './TeamInvitations.js';
export function TeamDialog({ onClose }: { onClose: () => void }) {
  const [account, setAccount] = useState<AccountOverview | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    void platform<AccountOverview>('/account')
      .then(setAccount)
      .catch((e: Error) => setError(e.message));
  }, []);
  return (
    <Modal title="团队与项目" onClose={onClose}>
      <div className="modal-body">
        {account ? (
          <>
            <TeamWelcome account={account} compact />
            {account.projects.find((p) => p.id === projectId())?.role === 'admin' && (
              <TeamInvitations project={projectId()} />
            )}
          </>
        ) : (
          <p>{error || '正在加载团队…'}</p>
        )}
      </div>
    </Modal>
  );
}

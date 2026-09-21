import { Store } from '../src/core/store.js';
import { Fleet } from '../src/core/fleet.js';
import { EventType, makeEvent } from '../src/protocol/events.js';

const store = new Store();
console.log('approvals before:', store.listApprovals({ status: null }).length);

// Exercise the exact shape the ACP adapter emits.
try {
  store.createApproval({
    id: 'appr_diag1',
    nodeId: 'hermes-local',
    taskId: null,
    requestId: 'edit-approval-2',
    title: 'Approve edit: D:\\工作\\probe-approved.txt',
    toolCallId: 'tc-1',
    options: [
      { optionId: 'allow_once', name: 'Allow edit', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
    auto: false,
  });
  console.log('direct createApproval: OK');
} catch (err) {
  console.log('direct createApproval THREW:', err.message);
}

// Now through Fleet.emit (the real path), with a valid task row.
const fleet = new Fleet({ store });
const task = store.createTask({ nodeId: 'hermes-local', prompt: 'diag' });
try {
  fleet.emit(
    makeEvent({
      nodeId: 'hermes-local',
      taskId: task.id,
      type: EventType.APPROVAL_REQUESTED,
      text: 'needs approval: diag',
      data: { id: 'appr_diag2', requestId: 7, nodeId: 'hermes-local', taskId: task.id, title: 'diag', toolCallId: null, options: [], policy: 'ask', requestedAt: new Date().toISOString() },
    }),
  );
  console.log('fleet emit + createApproval: OK');
} catch (err) {
  console.log('fleet emit THREW:', err.message);
}

console.log('approvals after:', store.listApprovals({ status: null }).map((a) => a.id));
store.close();

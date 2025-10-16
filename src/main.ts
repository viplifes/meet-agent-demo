import { AgentDispatchClient } from 'livekit-server-sdk';
import {
  WorkerOptions,
  cli,
} from '@livekit/agents';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// connect to room
export async function createExplicitDispatch() {
  const url = process.env.LIVEKIT_URL ?? "";
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  const agentName = process.env.LIVEKIT_AGENT_NAME ?? "";
  const roomName = process.env.LIVEKIT_CONNECT_TO_ROOM ?? "";
  const agentDispatchClient = new AgentDispatchClient(url, key, secret);
  // create a dispatch request for an agent named "test-agent" to join "my-room"
  const dispatch = await agentDispatchClient.createDispatch(roomName, agentName, {
    metadata: 'my_job_metadata',
  });
  const dispatches = await agentDispatchClient.listDispatch(roomName);
  console.log(`there are ${dispatches.length} dispatches in ${roomName}`);
}
setTimeout(createExplicitDispatch, 3000);

cli.runApp(new WorkerOptions({
  agentName: process.env.LIVEKIT_AGENT_NAME ?? "test-ai-agent",
  agent: join(__dirname, 'realtime_agent.ts')
}));
import { createApplication } from './application.js';
const server = await createApplication();
await server.app.listen(server.services.config.port, server.services.config.host);
console.log(
  'Team Agent API: http://' + server.services.config.host + ':' + server.services.config.port,
);
console.log(
  'Storage: ' +
    server.services.db.mode +
    ' · runtime data remains under the configured data directory',
);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await server.close();
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

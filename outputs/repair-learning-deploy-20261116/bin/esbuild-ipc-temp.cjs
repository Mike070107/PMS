// Environment-only preload, active exclusively in the selected Web Vite CLI.
// pnpm itself creates TEMP; defer choosing the intentionally unavailable transfer directory until Vite starts.
const path=require('node:path'),fs=require('node:fs');
if(path.basename(process.argv[1]||'')==='vite.js'){
  const root=path.resolve(__dirname,'../../..');
  const expected=path.join(root,'apps/neighbor-web');
  if(path.resolve(process.cwd()).toLowerCase()!==expected.toLowerCase())throw new Error('Unexpected Vite project for IPC-only TEMP');
  const ipcOnly=path.join(root,'outputs/repair-learning-deploy-20261116/temp-web-build/vite-ipc-not-created');
  if(fs.existsSync(ipcOnly))throw new Error('Vite IPC-only TEMP must remain nonexistent');
  process.env.TEMP=ipcOnly;process.env.TMP=ipcOnly;
  console.log('[esbuild IPC fallback] Vite-only TEMP set after pnpm startup; native compiler and source unchanged');
}

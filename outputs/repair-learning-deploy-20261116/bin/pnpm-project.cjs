// Use bundled pnpm's supported non-recursive project commands. Never mutate shared dependency junctions.
const cp=require('node:child_process'),path=require('node:path'),fs=require('node:fs');
const args=process.argv.slice(2);const root=path.resolve(__dirname,'../../..');
const projects={'@pms/api':'apps/api','@pms/neighbor-web':'apps/neighbor-web','@pms/admin-web':'apps/admin-web','@pms/shared-types':'packages/shared-types','@pms/api-client':'packages/api-client'};
if(args[0]!=='--filter'||!projects[args[1]])throw new Error('Unsupported pnpm delegation; refusing ambiguous project selection: '+JSON.stringify(args));
const selected=args[1],dir=path.join(root,projects[selected]);
if(JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8')).name!==selected)throw new Error('Project identity mismatch');
const rest=args.slice(2),cmd=['--dir',dir,'--ignore-workspace','--config.verify-deps-before-run=false',...(rest[0]==='exec'?rest:['run',...rest])];
const env={...process.env,pnpm_config_verify_deps_before_run:'false'};
// esbuild 0.21.3 has an intentional IPC fallback when its >1MiB temporary-input write fails.
// Local native esbuild cannot delete transfer files even with verified full directory rights.
// Scope this optimization fallback to Web build only; test/exec/API commands keep normal TEMP.
if(selected==='@pms/neighbor-web'&&rest.length===1&&rest[0]==='build'){
  const preload=path.join(__dirname,'esbuild-ipc-temp.cjs');
  env.NODE_OPTIONS=((env.NODE_OPTIONS||'')+' --require '+JSON.stringify(preload)).trim();
  console.log('[esbuild IPC fallback] Vite-only environment preload; no compiler/source/dependency/permission patch');
}
console.log('[local junction-compatible pnpm] '+JSON.stringify({selected,args:cmd}));
const result=cp.spawnSync('C:\\Users\\Administrator\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe',['C:\\Users\\Administrator\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\pnpm\\bin\\pnpm.mjs',...cmd],{stdio:['inherit',1,1],env});
if(result.error)throw result.error;process.exit(result.status??1);

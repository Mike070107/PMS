import {build} from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
const app=path.resolve(import.meta.dirname,'..');
await build({configFile:false,root:app,base:'/',plugins:[react()],resolve:{alias:{'@':path.join(app,'src'),'@pms/api-client':path.resolve(app,'../../packages/api-client/src'),'@pms/shared-types':path.resolve(app,'../../packages/shared-types/src')}},build:{target:'esnext',outDir:process.argv[2] || path.resolve(process.env.TMPDIR || process.env.TEMP || app,'pms-calendar-evidence/fixture-dist'),emptyOutDir:true,rollupOptions:{input:path.join(app,'test/calendar-browser.html')}}});

import { chromium } from '@playwright/test';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';

const ROOT = 'build';
const MIME: Record<string,string> = {'.html':'text/html','.css':'text/css','.js':'text/javascript','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png'};
const server = createServer((req,res)=>{
  let p = decodeURIComponent((req.url??'/').split('?')[0]);
  let f = join(ROOT, p);
  if (existsSync(f) && !extname(f)) f = join(f,'index.html');
  if (!existsSync(f)) f = join(ROOT, p + '.html');
  if (!existsSync(f)) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, {'content-type': MIME[extname(f)] ?? 'application/octet-stream'});
  res.end(readFileSync(f));
});
async function main(){
  await new Promise<void>(r=>server.listen(4599,r));
  const b = await chromium.launch();
  const pg = await b.newPage({viewport:{width:1100,height:1400}});
  const OUT='/tmp/claude-1000/-home-matt-Github-tripleNotes/d05af604-7d8a-4bb4-94db-fe16974cabb6/scratchpad/shots';
  for (const [name,url] of [['hub','/docs/user-paths/user-paths'],['core','/docs/user-paths/core-loop'],['everyday','/docs/user-paths/everyday-notes']]){
    await pg.goto(`http://localhost:4599${url}`,{waitUntil:'networkidle'});
    const fig = pg.locator('figure.diagram').first();
    if (await fig.count()) { await fig.screenshot({path:`${OUT}/${name}-diagram.png`}); }
    await pg.screenshot({path:`${OUT}/${name}.png`, fullPage:false});
    console.log(name, 'ok');
  }
  await b.close(); server.close();
}
main().catch(e=>{console.error(e);process.exit(1)});

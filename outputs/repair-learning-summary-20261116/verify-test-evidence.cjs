const fs=require('node:fs'),assert=require('node:assert/strict');
const base='outputs/repair-learning-summary-20261116/';
const rows=[['api-regressions-pushed-main.txt',195],['summary/after-tests.txt',14]];
const evidence=rows.map(([file,count])=>{
 const bytes=fs.readFileSync(base+file),text=bytes.toString(bytes[0]===255&&bytes[1]===254?'utf16le':'utf8').replace(/^\uFEFF/,'');
 assert(new RegExp('(?:#|ℹ) tests '+count+'\\b').test(text),file+' wrong test count');
 assert(new RegExp('(?:#|ℹ) pass '+count+'\\b').test(text),file+' wrong pass count');
 assert(/(?:#|ℹ) fail 0\b/.test(text),file+' has failures');
 const utf8=file.replace(/\.txt$/,'.utf8.txt'); fs.writeFileSync(base+utf8,text,'utf8');
 return {file:utf8,tests:count,pass:count,fail:0};
});
fs.writeFileSync(base+'test-proof.json',JSON.stringify({checkedAt:new Date().toISOString(),sourceCommit:JSON.parse(fs.readFileSync(base+'source-freeze.json')).head,evidence},null,2)+'\n');
console.log(JSON.stringify(evidence));

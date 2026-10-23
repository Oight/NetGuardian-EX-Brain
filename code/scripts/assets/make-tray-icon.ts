import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';

const size=24;
const rows=Buffer.alloc(size*(1+size*4));
const outer=[[12,1],[22,5],[20,16],[12,23],[4,16],[2,5]];
const inner=[[12,4],[19,7],[17,15],[12,19],[7,15],[5,7]];
function inside(x:number,y:number,points:number[][]){let value=false;for(let i=0,j=points.length-1;i<points.length;j=i++){const [xi,yi]=points[i]!,[xj,yj]=points[j]!;if((yi!>y)!==(yj!>y)&&x<(xj!-xi!)*(y-yi!)/(yj!-yi!)+xi!)value=!value;}return value;}
for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const offset=y*(1+size*4)+1+x*4;
  const color=inside(x+0.5,y+0.5,inner)?[20,32,44,255]:inside(x+0.5,y+0.5,outer)?[105,217,180,255]:[0,0,0,0];
  for(let c=0;c<4;c++)rows[offset+c]=color[c]!;
}
function crc32(bytes:Uint8Array){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^0xffffffff)>>>0;}
function chunk(name:string,data:Buffer){const type=Buffer.from(name);const length=Buffer.alloc(4);length.writeUInt32BE(data.length);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([type,data])));return Buffer.concat([length,type,data,crc]);}
const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
const image=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
await mkdir('apps/desktop/assets',{recursive:true});await writeFile('apps/desktop/assets/tray.png',image);

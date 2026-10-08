// Test double only. Does not parse documents or detect accessibility violations.
import http from 'node:http';
import { sampleIssues,sampleClean } from '../frontend/samples.js';
const port=Number(process.env.MOCK_PORT || 3087);
http.createServer(async(req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','http://127.0.0.1:3086');
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
  const send=(status,data)=>{res.writeHead(status);res.end(JSON.stringify(data));};
  if(req.url==='/health')return send(200,{status:'ok'});
  if(req.url==='/formats')return send(200,{supported_mime_types:['text/html','application/pdf'],max_file_size_mb:10});
  if(req.method!=='POST' || req.url!=='/analyze')return send(404,{error:{code:'NOT_FOUND',message:'Test endpoint not found.'}});
  let body='';for await (const chunk of req)body+=chunk.toString();
  const name=body.match(/filename="([^"]*)"/)?.[1] || '';
  if(name.includes('unavailable'))return send(503,{error:{code:'PROCESSING_UNAVAILABLE',message:'The required AI service is unavailable. Try again later.'}});
  if(name.includes('corrupt'))return send(422,{error:{code:'UNPROCESSABLE_FILE',message:'The file could not be evaluated.'}});
  if(name.includes('partial'))return send(200,{issues:[{description:'Incomplete finding'}]});
  if(name.includes('slow'))return setTimeout(()=>send(200,sampleIssues),35_000);
  if(name.includes('clean'))return send(200,sampleClean);
  send(200,sampleIssues);
}).listen(port,'127.0.0.1',()=>console.log(`TEST DOUBLE ONLY: http://127.0.0.1:${port}`));

#!/usr/bin/env node
import {readFile,readdir,lstat,writeFile} from 'node:fs/promises';
import {join,relative,sep} from 'node:path';
import {compileProtocolPackage} from '../dist-workspace/src/protocol-compiler.js';
import {inspectProtocolPackage,parseProtocolPackage,parseProtocolPackageBytes} from '../dist-workspace/src/protocol-package.js';
import {canonicalProtocolPackageClosureBytes,createProtocolPackageClosure,digestProtocolPackageClosure,exactPackageLoader,parseProtocolPackageClosureBytes} from '../dist-workspace/src/protocol-package-closure.js';

function usage(){console.error('Usage: protocol-package.mjs <inspect|validate|compile|test> <bundle.json> [--dependency <bundle.json>]... [--bind <name>=<JSON>]...\n       protocol-package.mjs closure-export <root-package> --dependency <exact-package>... --out <canonical-closure.json>\n       protocol-package.mjs closure-test <canonical-closure.json>');process.exit(2);}
const [command,file,...args]=process.argv.slice(2);if(!['inspect','validate','compile','test','closure-export','closure-test'].includes(command)||!file)usage();if(command==='closure-test'&&args.length)usage();
const dependencyFiles=[],bindings={};let outputFile;
for(let index=0;index<args.length;index++){
 const option=args[index],value=args[++index];if(!value)usage();
 if(option==='--dependency')dependencyFiles.push(value);
 else if(option==='--out'&&command==='closure-export'){if(outputFile)usage();outputFile=value;}
 else if(option==='--bind'){const split=value.indexOf('=');if(split<1)usage();const name=value.slice(0,split);if(Object.hasOwn(bindings,name))throw new Error(`duplicate binding ${name}`);bindings[name]=JSON.parse(value.slice(split+1));}
 else usage();
}
if(command==='closure-export'&&!outputFile)usage();
async function load(path){
 const info=await lstat(path);if(info.isSymbolicLink())throw new Error('package path cannot be a symbolic link');if(info.isFile())return parseProtocolPackageBytes(await readFile(path));if(!info.isDirectory())throw new Error('package path must be a regular file or directory');
 const files=Object.create(null);async function walk(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const absolute=join(directory,entry.name),stat=await lstat(absolute);if(stat.isSymbolicLink())throw new Error('package directories cannot contain symbolic links');if(stat.isDirectory())await walk(absolute);else if(stat.isFile())files[relative(path,absolute).split(sep).join('/')]=await readFile(absolute,'utf8');else throw new Error('package directories may contain regular files only');}}
 await walk(path);return parseProtocolPackage({format:'peerwork.protocol-package.v1',files});
}
try{
 if(command==='closure-test'){
  const closure=parseProtocolPackageClosureBytes(await readFile(file)),result=compileProtocolPackage(closure.rootPackage,{loadExactPackage:exactPackageLoader(closure)});
  console.log(JSON.stringify({closurePackages:closure.packages.size,rootPackageDigest:closure.rootPackage.packageDigest,protocolDigest:result.protocolDigest,fixtures:result.fixtureResults,passed:result.passed,validation:result.validation},null,2));if(!result.validation.passed||!result.passed)process.exitCode=1;
 }else{
 const pkg=await load(file);
 if(command==='inspect')console.log(JSON.stringify(inspectProtocolPackage(pkg.bundle),null,2));
 else if(command==='closure-export'){
  const dependencies=[];for(const path of dependencyFiles)dependencies.push(await load(path));const closure=createProtocolPackageClosure(pkg,dependencies),bytes=canonicalProtocolPackageClosureBytes(closure),parsedClosure=parseProtocolPackageClosureBytes(bytes),result=compileProtocolPackage(parsedClosure.rootPackage,{loadExactPackage:exactPackageLoader(parsedClosure)});if(!result.validation.passed||!result.passed)throw new Error('closure package fixtures did not pass');await writeFile(outputFile,bytes,{flag:'wx'});console.log(JSON.stringify({output:outputFile,closureDigest:digestProtocolPackageClosure(closure),rootPackageDigest:pkg.packageDigest,protocolDigest:result.protocolDigest,packageDigests:[...parsedClosure.packages.keys()].sort(),fixturesPassed:result.fixtureResults.filter(row=>row.passed).length}));
 }
 else{
  const dependencies=new Map();for(const path of dependencyFiles){const dependency=await load(path);if(dependencies.has(dependency.packageDigest))throw new Error(`duplicate dependency digest ${dependency.packageDigest}`);dependencies.set(dependency.packageDigest,dependency);}
  const result=compileProtocolPackage(pkg,{loadExactPackage:digest=>dependencies.get(digest),bindings});
  const output=command==='test'?{packageDigest:result.packageDigest,protocolDigest:result.protocolDigest,fixtures:result.fixtureResults,passed:result.passed,validation:result.validation}:command==='validate'?{packageDigest:result.packageDigest,protocolDigest:result.protocolDigest,validation:result.validation,fixtures:result.fixtureResults,passed:result.validation.passed&&result.passed}:result;
  console.log(JSON.stringify(output,null,2));if(!result.validation.passed||!result.passed)process.exitCode=1;
 }
 }
}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}

// PDF.js 6.3.289, extracted from the pinned DSH build; see LICENSE.txt.
import pdfjs from './pdf.mjs';
import {createPdfBinaryDataFactory} from './binary-assets.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.mjs',import.meta.url).href;
const BinaryDataFactory=createPdfBinaryDataFactory();
const configured={...pdfjs,getDocument(options){return pdfjs.getDocument({...options,BinaryDataFactory,cMapPacked:true,useWorkerFetch:false,enableXfa:false,isEvalSupported:false});}};
export function loadPdfjs(){return configured;}
export default loadPdfjs;

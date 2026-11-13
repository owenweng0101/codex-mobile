import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Evaluate only our trusted IIFE to obtain the same self-contained zoom script
// the client uses. No HTML, paths or other request input enters this VM.
const sandbox={window:{}};
vm.runInNewContext(readFileSync(new URL('./media-preview.js',import.meta.url),'utf8'),sandbox,{timeout:1000});
const bootstrap=sandbox.window.claudeHtmlPreviewBootstrap;

/** Call AFTER authorization and embedHtmlAssets(), only for preview=html.
 * Keep the existing /api/file response CSP and iframe sandbox unchanged.
 * Invalid tokens produce the original document, never executable input.
 */
export function injectHtmlPreview(text,token){
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(token))return text;
  const script=bootstrap(token).replace(/<\/script/gi,'<\\/script');
  // Appending avoids regex replacement inside user JS strings or comments.
  // The HTML parser reopens the body after </html>; the document stays intact.
  return text+'\n<script data-claude-preview-zoom>'+script+'</script>';
}

/* The hub only switches apps. Workspace actions stay in each app's workspace row. */
(() => {
  const sliders='<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1" aria-hidden="true"><path d="M2.3 5h5.85M12.05 5h1.65"/><circle cx="9.95" cy="5" r="1.45"/><path d="M2.3 11h1.65M7.85 11h5.85"/><circle cx="5.75" cy="11" r="1.45"/></svg>';
  const css={
    codex:`
      /* iOS ignores plain overflow:hidden on the root; fixed+inset is what actually locks the page. */
      html,body{position:fixed!important;inset:0!important;width:100%!important;height:100%!important;overflow:hidden!important;overscroll-behavior:none!important;max-width:100vw!important}
      /* The hub shell already reserves the device insets; a framed full-page
         overlay that repeats env() would pad the same edge twice. */
      html[data-mobile-hub][data-codex-mobile="true"] :is([data-workspace-side-frame][aria-hidden="false"],[data-mobile-side-pane-overlay]>div){padding-top:0!important;padding-bottom:0!important}
      [data-testid="sidebar-primary-navigation"]{height:0!important;min-height:0!important;padding:0!important;overflow:visible!important}
      [data-testid="sidebar-primary-navigation"]::before{display:none!important}
      [data-testid="sidebar-search-toolbar"]{height:0!important;min-height:0!important;padding:0!important;overflow:visible!important}
      [data-testid="sidebar-search-open"],button[aria-label="选择主题"]{display:none!important}
      [data-testid="sidebar-view-menu"]{position:fixed!important;top:0!important;right:12px!important;width:1px!important;height:1px!important;min-width:0!important;min-height:0!important;opacity:0!important;pointer-events:none!important}
      [data-testid="sidebar-task-list-region"]{padding-top:0!important;border-top:0!important}
    `,
    dsh:`
      html,body{position:fixed!important;inset:0!important;width:100%!important;height:100%!important;overflow:hidden!important;overscroll-behavior:none!important;max-width:100vw!important}
      /* The hub shell already reserves the device insets; the framed shell must
         not resolve env(safe-area-inset-*) a second time against its own viewport. */
      html[data-mobile-hub]{--dshm-safe-top:0px;--dshm-safe-bottom:0px}
      html[data-mobile-hub][data-dshm-mobile] :is([data-dshm-frame],[data-rightbar-col]){padding-top:0!important;padding-bottom:0!important}
      body{--dsw-alias-bg-base:var(--hub-canvas)!important;--dsw-specific-sidebar-fill:var(--hub-canvas)!important;--dshm-sidebar-bg:var(--hub-canvas)!important}
      html[data-mobile-hub] body{font-family:-apple-system,system-ui,"SF Pro Text","PingFang SC",sans-serif!important}
      body,[data-dshm-main],[data-dshm-sidebar],[data-dshm-header]{background:var(--hub-canvas)!important}
      [data-dshm-logo],button[aria-label="搜索会话"],[class*="_search"]:has(>button[aria-label="搜索会话"]){display:none!important}
      html[data-mobile-hub] .kB3qhq_root:has(.Kjh-qa_root){padding-top:0!important;padding-bottom:0!important}
      /* The sidebar content box is 8..374 at 390px; +24px with the -8px shift makes
         the section header paint 0..390 so its right-hand view-options button keeps
         the app's native right edge. Shrinking the width clipped that edge instead. */
      html[data-mobile-hub] .Kjh-qa_sectionHeader{gap:0!important;width:calc(100% + 24px)!important;flex-shrink:0!important;transform:translateX(-8px);box-sizing:border-box!important;height:40px!important;min-height:40px!important;padding:0 12px 0 20px!important;margin:0!important;font:400 13px/19.5px -apple-system,system-ui,"SF Pro Text","PingFang SC",sans-serif!important;color:var(--hub-muted)!important}
      html[data-mobile-hub] .Kjh-qa_sectionLabel{font:inherit!important;left:0!important;margin-left:0!important}
      html[data-mobile-hub] .Kjh-qa_sectionLabel:not(.Kjh-qa_sectionLabelHidden){flex:1!important;max-width:none!important}
      html[data-mobile-hub] .Kjh-qa_headerActions{margin-left:auto!important}
      html[data-mobile-hub] .Kjh-qa_iconButton{width:32px!important;height:36px!important;border-radius:8px!important}
      html[data-mobile-hub] .Kjh-qa_groupSection{flex-shrink:0!important}
      /* Native AnimatedRows arms its FLIP translate on pointerdown. The group
         height animation below already moves these rows; applying both makes
         them overshoot then spring back. Keep native opacity, not its translate. */
      html[data-mobile-hub] .Kjh-qa_list [data-row-key]{transform:none!important}
      /* The full-bleed section header is wider than this scroller; clip sideways
         overflow so the extra width can never create a horizontal scrollbar. */
      /* Browser scroll anchoring fights the animated folder height: it rewrites
         scrollTop mid-animation, which reads as a shake on iOS. */
      html[data-mobile-hub] .Kjh-qa_list{padding-bottom:16px!important;overflow-x:clip!important;overflow-anchor:none!important}
      /* Codex folders use the leading open/closed glyph as disclosure; the native row owns onToggle. */
      html[data-mobile-hub] :is(.JoiKIa_projectRow,.JoiKIa_sessionRow){max-width:100%!important;overflow:hidden!important;height:36px!important;min-height:36px!important;box-sizing:border-box!important;border:0!important;margin-right:-3px!important;padding:0 4px 0 calc(12px + var(--dsh-workspace-indent,0px))!important;gap:8px!important;border-radius:8px!important;color:var(--hub-ink)!important;transition:background-color 150ms cubic-bezier(.4,0,.2,1)}
      html[data-mobile-hub] .JoiKIa_projectRow{--hub-folder:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20aria-hidden%3D%22true%22%3E%3Cpath%20d%3D%22M20%2020a2%202%200%200%200%202-2V8a2%202%200%200%200-2-2h-7.9a2%202%200%200%201-1.69-.9L9.6%203.9A2%202%200%200%200%207.93%203H4a2%202%200%200%200-2%202v13a2%202%200%200%200%202%202Z%22%2F%3E%3C%2Fsvg%3E");--hub-folder-open:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20aria-hidden%3D%22true%22%3E%3Cpath%20d%3D%22m6%2014%201.5-2.9A2%202%200%200%201%209.24%2010H20a2%202%200%200%201%201.94%202.5l-1.54%206a2%202%200%200%201-1.95%201.5H4a2%202%200%200%201-2-2V5a2%202%200%200%201%202-2h3.9a2%202%200%200%201%201.69.9l.81%201.2a2%202%200%200%200%201.67.9H18a2%202%200%200%201%202%202v2%22%2F%3E%3C%2Fsvg%3E");--hub-create:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20aria-hidden%3D%22true%22%3E%3Cpath%20d%3D%22M2.992%2016.342a2%202%200%200%201%20.094%201.167l-1.065%203.29a1%201%200%200%200%201.236%201.168l3.413-.998a2%202%200%200%201%201.099.092%2010%2010%200%201%200-4.777-4.719%22%2F%3E%3Cpath%20d%3D%22M8%2012h8M12%208v8%22%2F%3E%3C%2Fsvg%3E")}
      html[data-mobile-hub] .JoiKIa_projectRow .JoiKIa_folder{display:inline-flex!important;width:16px!important;height:16px!important;flex:0 0 16px!important;background:var(--hub-muted);mask:var(--hub-folder) center/16px 16px no-repeat;-webkit-mask:var(--hub-folder) center/16px 16px no-repeat}
      html[data-mobile-hub] .JoiKIa_projectRow[aria-expanded="true"] .JoiKIa_folder{mask-image:var(--hub-folder-open);-webkit-mask-image:var(--hub-folder-open)}
      html[data-mobile-hub] .JoiKIa_projectRow :is(.JoiKIa_folder>svg,.JoiKIa_chevron){display:none!important}
      html[data-mobile-hub] .JoiKIa_projectText{margin:0!important;gap:0!important}
      html[data-mobile-hub] .JoiKIa_projectRow .JoiKIa_title{font:400 14px/21px -apple-system,system-ui,"SF Pro Text","PingFang SC",sans-serif!important}
      html[data-mobile-hub] .JoiKIa_sessionRow .JoiKIa_title{font:400 14px/20px -apple-system,system-ui,"SF Pro Text","PingFang SC",sans-serif!important;margin:0!important}
      html[data-mobile-hub] .JoiKIa_sessionRow>.JoiKIa_slot{width:16px!important;flex:0 0 16px!important}
      html[data-mobile-hub] .JoiKIa_projectRow .JoiKIa_rowActions{display:inline-flex!important;height:32px!important;gap:0!important;opacity:1!important;visibility:visible!important}
      html[data-mobile-hub] :is(.JoiKIa_projectRow,.JoiKIa_sessionRow) .JoiKIa_iconButton{box-sizing:border-box!important;width:32px!important;height:32px!important;min-width:32px!important;margin:0!important;padding:0!important;border-radius:8px!important;color:var(--hub-muted)!important}
      html[data-mobile-hub] :is(.JoiKIa_projectRow,.JoiKIa_sessionRow) .JoiKIa_iconButton>svg{width:14px!important;height:14px!important}
      html[data-mobile-hub] .JoiKIa_projectRow .JoiKIa_iconButton:has(>[data-icon="dsw-icon-new-chat-outline-regular"])::before{content:"";width:14px;height:14px;background:currentColor;mask:var(--hub-create) center/contain no-repeat;-webkit-mask:var(--hub-create) center/contain no-repeat}
      html[data-mobile-hub] .JoiKIa_projectRow .JoiKIa_iconButton>[data-icon="dsw-icon-new-chat-outline-regular"]{display:none!important}
      html[data-mobile-hub] :is(.JoiKIa_time,.JoiKIa_timestamp){font-size:11px!important;line-height:18px!important;color:var(--hub-muted)!important}
      html[data-mobile-hub] .Kjh-qa_groupSection>*+*{margin-top:4px!important}
      html[data-mobile-hub] :is(.JoiKIa_projectRow,.JoiKIa_sessionRow):active,html[data-mobile-hub] .JoiKIa_iconButton:active{background-color:var(--hub-hover)!important}
      html[data-mobile-hub] :is(.JoiKIa_projectRow,.JoiKIa_sessionRow,.JoiKIa_iconButton):focus-visible{outline:2px solid var(--hub-muted)!important;outline-offset:-2px!important}
      @media(hover:hover){html[data-mobile-hub] :is(.JoiKIa_projectRow,.JoiKIa_sessionRow,.JoiKIa_iconButton):hover{background-color:var(--hub-hover)!important}}
      @media(prefers-reduced-motion:reduce){html[data-mobile-hub] :is(.JoiKIa_projectRow,.JoiKIa_sessionRow){transition:none!important}}
    `,
    claude:`
      /* Match the other two frames: the document itself never scrolls, only the
         app's own panes; touch-action keeps vertical panning and blocks sideways
         swipes from turning into browser back/forward gestures. */
      html,body{position:fixed!important;inset:0!important;width:100%!important;height:100%!important;overflow:hidden!important;overscroll-behavior:none!important;max-width:100vw!important}
      html{touch-action:pan-y!important}
      :root{--bg:var(--hub-canvas)!important;--surface:var(--hub-panel)!important;--text:var(--hub-ink)!important;--muted:var(--hub-muted)!important;--faint:var(--hub-faint)!important;--line:var(--hub-line)!important;--bubble:var(--hub-bubble)!important;--hover:var(--hub-hover)!important}
      body,.bar,#list{background:var(--hub-canvas)!important}
      .bar:has(#back[hidden]){display:none!important}
      .bar{min-height:40px!important;padding-top:0!important;border-bottom:0!important}
      .bar .icon{height:36px!important}
      #new{display:none!important}
    `
  };
  const sharedCSS=`
    .hub-workspace-toolbar{display:flex;align-items:center;box-sizing:border-box;height:40px;min-height:40px;padding:0 12px 0 20px;gap:8px;color:var(--hub-muted);font:400 13px/19.5px -apple-system,system-ui,"SF Pro Text","PingFang SC",sans-serif;background:var(--hub-canvas);flex-shrink:0}
    .hub-workspace-toolbar>span{flex:1}
    .hub-workspace-view{width:32px;height:36px;display:grid;place-items:center;border:0;border-radius:8px;background:transparent;color:var(--hub-muted);cursor:pointer}
    .hub-workspace-view:active{background:var(--hub-hover)}
    html[data-mobile-hub] [role="listbox"]{max-height:60vh!important;overflow-y:auto!important}
    html[data-mobile-hub] :is([role="menu"],[role="listbox"],[data-slot="dropdown-menu-content"],[data-slot="dropdown-menu-sub-content"],[data-slot="context-menu-content"],[data-slot="context-menu-sub-content"]){padding:8px!important;border-radius:16px!important;font:400 14px/20px -apple-system,system-ui,"SF Pro Text","PingFang SC",sans-serif!important}
    html[data-mobile-hub] :is([role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"],.menu-option){box-sizing:border-box!important;min-height:36px!important;padding:7px 8px!important;border-radius:8px!important;font:400 14px/20px -apple-system,system-ui,"SF Pro Text","PingFang SC",sans-serif!important}
  `;
  window.installMobileHubChrome=frames=>{
    document.getElementById('hubActions').replaceChildren();
    const documents=new WeakSet(),palettes=new WeakMap(),dshGroups=new WeakMap(),dshTaps=new WeakMap(),dshAnimations=new Map();let current='codex';
    const tokens=['canvas','panel','ink','muted','faint','line','bubble','hover'];
    const light=['#f9fafb','#ffffff','#0f1115','#61666b','#81858c','#e5e7ea','#eceef1','#eceef0'];
    const dark=['#151517','#232324','#f0f1f2','#aaafb7','#999fa8','#393d43','#2d3035','#33363b'];
    let safeBottom=0;
    function docOf(name){try{return frames.get(name)?.contentDocument;}catch{return null;}}
    // env() inside a framed document is 0 on iOS, so the parent measures the real
    // inset once and publishes it to every frame as a plain custom property.
    function measureSafeBottom(){
      try{
        const probe=document.createElement('div');
        probe.style.cssText='position:fixed;left:0;bottom:0;width:1px;height:env(safe-area-inset-bottom);visibility:hidden;pointer-events:none';
        document.body.appendChild(probe);
        const pad=probe.getBoundingClientRect().height;
        probe.remove();
        return Number.isFinite(pad)&&pad>0?Math.round(pad*100)/100:0;
      }catch{return 0;}
    }
    function syncSafeBottom(){
      safeBottom=measureSafeBottom();
      const value=safeBottom+'px';
      try{document.documentElement.style.setProperty('--hub-safe-bottom',value);}catch{}
      for(const [name] of frames){
        const doc=docOf(name);
        try{doc?.documentElement?.style.setProperty('--hub-safe-bottom',value);}catch{}
      }
    }
    function forgetDshTap(group){
      const tap=dshTaps.get(group);if(!tap)return null;
      dshTaps.delete(group);
      try{tap.view?.clearTimeout?.(tap.timer);}catch{}
      return tap;
    }
    // Captured in the click phase, before React's own click handler mutates the tree.
    function rememberDshTap(group,port,view){
      forgetDshTap(group);
      const tap={port,top:port?.scrollTop||0,height:group.getBoundingClientRect().height,view};
      dshTaps.set(group,tap);
      try{tap.timer=view?.setTimeout?.(()=>{if(dshTaps.get(group)===tap)dshTaps.delete(group);},1000);}catch{}
    }
    function dshVisible(doc,group){return current==='dsh'&&!document.hidden&&!doc.hidden&&group.isConnected&&group.getClientRects().length>0;}
    function cancelDshAnimation(group){
      const entry=dshAnimations.get(group);if(!entry)return;
      dshAnimations.delete(group);dshGroups.delete(group);
      const animation=entry.record.animation;entry.record.animation=null;animation?.cancel();
    }
    function stopDshAnimations(doc,hiddenOnly=false){
      for(const [group,entry] of dshAnimations){
        if((!doc||entry.doc===doc)&&(!hiddenOnly||!dshVisible(entry.doc,group)))cancelDshAnimation(group);
      }
    }
    function palette(){
      let isDark=matchMedia('(prefers-color-scheme:dark)').matches;
      try{const saved=localStorage.getItem('clm-hub-codex-scheme');if(saved==='dark'||saved==='light')isDark=saved==='dark';}catch{}
      const codex=docOf('codex');
      if(codex?.documentElement&&codex.defaultView){
        const canvas=codex.defaultView.getComputedStyle(codex.documentElement).getPropertyValue('--cm-canvas').trim();
        if(canvas==='#151517'||canvas==='#f9fafb'){isDark=canvas==='#151517';try{localStorage.setItem('clm-hub-codex-scheme',isDark?'dark':'light');}catch{}}
      }
      const values=isDark?dark:light,key=values.join('|');
      const scheme=isDark?'dark':'light';
      const root=document.documentElement;
      if(root.style.colorScheme!==scheme)root.style.colorScheme=scheme;
      for(const [name,value] of Object.entries({'--bg':values[0],'--surface':values[0],'--capsule-active':values[1],'--text':values[2],'--muted':values[3],'--line':values[5],'--hover':values[7]}))root.style.setProperty(name,value);
      for(const [name] of frames){
        const doc=docOf(name);if(!doc?.body)continue;
        if(palettes.get(doc)!==key){
          for(let i=0;i<tokens.length;i++)doc.documentElement.style.setProperty('--hub-'+tokens[i],values[i]);
          if(name==='claude'){doc.documentElement.style.setProperty('--accent',isDark?'#da8a67':'#c15f3c');doc.documentElement.style.setProperty('--accent-text',isDark?'#151517':'#ffffff');}
          palettes.set(doc,key);
        }
        // Native theme snapshots can arrive after load, even while the frame is hidden.
        if(name!=='codex'&&doc.documentElement.style.colorScheme!==scheme)doc.documentElement.style.colorScheme=scheme;
        if(name==='dsh'){if(isDark&&!doc.body.hasAttribute('data-ds-dark-theme'))doc.body.setAttribute('data-ds-dark-theme','');else if(!isDark&&doc.body.hasAttribute('data-ds-dark-theme'))doc.body.removeAttribute('data-ds-dark-theme');}
      }
    }
    function mark(name,doc,mutations=[]){
      if(name==='codex'){
        const region=doc.querySelector('[data-testid="sidebar-task-list-region"]');
        const target=doc.querySelector('[data-testid="sidebar-view-menu"]');
        if(region&&target){
          let toolbar=region.querySelector(':scope>.hub-workspace-toolbar');
          if(!toolbar){toolbar=doc.createElement('div');toolbar.className='hub-workspace-toolbar';const label=doc.createElement('span');label.textContent='工作区';const button=doc.createElement('button');button.type='button';button.className='hub-workspace-view';button.setAttribute('aria-label','视图选项');button.setAttribute('aria-haspopup','menu');button.innerHTML=sliders;toolbar.append(label,button);region.prepend(toolbar);
            const prepareOriginal=()=>{
              const original=doc.querySelector('[data-testid="sidebar-view-menu"]');
              if(!original||original.disabled||original.closest('[inert]'))return null;
              const rect=button.getBoundingClientRect();
              for(const [property,value] of Object.entries({top:rect.top+'px',left:rect.left+'px',right:'auto',width:rect.width+'px',height:rect.height+'px'}))original.style.setProperty(property,value,'important');
              return original;
            };
            button.onclick=()=>{
              const original=prepareOriginal();if(!original)return;
              const view=doc.defaultView;
              for(const type of ['pointerdown','pointerup'])original.dispatchEvent(new view.PointerEvent(type,{bubbles:true,cancelable:true,pointerType:'mouse',button:0,isPrimary:true}));
            };
            button.onkeydown=event=>{
              if(!['Enter',' ','ArrowDown'].includes(event.key))return;
              const original=prepareOriginal();if(!original)return;
              event.preventDefault();event.stopPropagation();
              const {key,code,ctrlKey,altKey,shiftKey,metaKey,repeat}=event;
              original.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown',{bubbles:true,cancelable:true,key,code,ctrlKey,altKey,shiftKey,metaKey,repeat}));
            };
          }
          const proxy=toolbar.querySelector('button');if(proxy.disabled!==target.disabled)proxy.disabled=target.disabled;const expanded=target.getAttribute('aria-expanded')||'false';if(proxy.getAttribute('aria-expanded')!==expanded)proxy.setAttribute('aria-expanded',expanded);
          const controls=target.getAttribute('aria-controls');
          if(controls!==proxy.getAttribute('aria-controls')){if(controls===null)proxy.removeAttribute('aria-controls');else proxy.setAttribute('aria-controls',controls);}
          target.setAttribute('aria-hidden','true');target.tabIndex=-1;
        }
      }else if(name==='dsh'){
        if(!doc.querySelector('[data-dshm-header]'))doc.querySelector('header')?.setAttribute('data-dshm-header','');
        // Animate the native group's height without moving React nodes or replacing its handlers.
        for(const group of doc.querySelectorAll('.Kjh-qa_groupSection')){
          const row=group.querySelector(':scope>.JoiKIa_projectRow,:scope>span>.JoiKIa_projectRow');if(!row)continue;
          const expanded=row.getAttribute('aria-expanded'),previous=dshGroups.get(group);
          if(!dshVisible(doc,group)){cancelDshAnimation(group);dshGroups.delete(group);forgetDshTap(group);continue;}
          // A nested group's height already drives its ancestors' layout. Never
          // capture that in-flight height as a second ancestor animation target.
          if(group.querySelector('.Kjh-qa_groupSection')){cancelDshAnimation(group);dshGroups.delete(group);forgetDshTap(group);continue;}
          if(previous?.expanded===expanded){
            if(previous.animation&&mutations.some(change=>change.type==='childList'&&(change.target===group||group.contains(change.target))&&[...(change.addedNodes||[]),...(change.removedNodes||[])].some(node=>node.nodeType===1&&(change.target===group||node.matches?.('[data-row-key]')||node.querySelector?.('[data-row-key]'))))){
              // Hydrated sessions may land while the first expansion is running.
              // Retarget now, not at finish (which would release to a different
              // natural height in one frame). Unrelated page mutations do nothing.
              const from=group.getBoundingClientRect().height,port=group.closest('.Kjh-qa_list'),top=port?.scrollTop||0;
              cancelDshAnimation(group);
              const height=group.getBoundingClientRect().height;
              const animation=from>0&&height>0&&from!==height&&!doc.defaultView.matchMedia('(prefers-reduced-motion:reduce)').matches
                ?group.animate([{height:from+'px',overflow:'clip'},{height:height+'px',overflow:'clip'}],{duration:300,easing:'cubic-bezier(.4,0,.2,1)'}) : null;
              const record={expanded,height,animation};dshGroups.set(group,record);
              if(animation){
                dshAnimations.set(group,{doc,record});
                const release=()=>{record.animation=null;if(dshAnimations.get(group)?.record===record)dshAnimations.delete(group);};
                animation.oncancel=release;animation.onfinish=release;
              }
              if(port?.isConnected&&top>0){group.getBoundingClientRect();port.scrollTop=top;}
              continue;
            }
            if(!previous.animation){
              const height=group.getBoundingClientRect().height;
              // Sessions can arrive after the group is already expanded. Animating
              // that delta keeps the list from jumping once the data lands.
              if(previous.height>0&&height>0&&Math.abs(height-previous.height)>1&&!doc.defaultView.matchMedia('(prefers-reduced-motion:reduce)').matches){
                const animation=group.animate([{height:previous.height+'px',overflow:'clip'},{height:height+'px',overflow:'clip'}],{duration:300,easing:'cubic-bezier(.4,0,.2,1)'});
                const record={expanded,height,animation};dshGroups.set(group,record);dshAnimations.set(group,{doc,record});
                const release=()=>{record.animation=null;if(dshAnimations.get(group)?.record===record)dshAnimations.delete(group);};
                animation.oncancel=release;animation.onfinish=release;
              }else previous.height=height;
            }
            continue;
          }
          // A tap captured the natural height before React re-rendered; it stands in
          // for the missing record on the first toggle after the drawer was opened.
          const tap=dshTaps.has(group)?forgetDshTap(group):null;
          // The height captured in the click phase is the real pre-toggle height.
          // Preferring a stale record made the first frame snap before the
          // animation started, which is the visible folder-toggle shake.
          const from=tap?.height||(previous?.animation?group.getBoundingClientRect().height:previous?.height);
          cancelDshAnimation(group);const height=group.getBoundingClientRect().height;
          const animation=from>0&&height>0&&from!==height&&!doc.defaultView.matchMedia('(prefers-reduced-motion:reduce)').matches
            ?group.animate([{height:from+'px',overflow:'clip'},{height:height+'px',overflow:'clip'}],{duration:300,easing:'cubic-bezier(.4,0,.2,1)'}) : null;
          const record={expanded,height,animation};dshGroups.set(group,record);
          if(tap?.port?.isConnected&&tap.top>0){
            // React removed the children before the animation restores the old
            // height, so the browser clamped the scroller. Reading the rect
            // applies the animation's first frame, then the offset is valid again.
            group.getBoundingClientRect();
            tap.port.scrollTop=tap.top;
          }
          if(animation){
            dshAnimations.set(group,{doc,record});
            const release=()=>{
              record.animation=null;
              if(dshAnimations.get(group)?.record===record)dshAnimations.delete(group);
            };
            animation.oncancel=release;
            animation.onfinish=release;
          }
        }

      }
      palette();
    }
    function attach(name){
      const doc=docOf(name);if(!doc?.body||documents.has(doc))return;documents.add(doc);
      const style=doc.createElement('style');style.id='mobile-hub-chrome';style.textContent=css[name]+sharedCSS;doc.head.append(style);doc.documentElement.dataset.mobileHub='true';
      try{doc.documentElement.style.setProperty('--hub-safe-bottom',safeBottom+'px');}catch{}
      mark(name,doc);let scheduled=false;new doc.defaultView.MutationObserver(mutations=>{if(name==='dsh'){stopDshAnimations(doc,true);mark(name,doc,mutations);return;}if(scheduled)return;scheduled=true;doc.defaultView.requestAnimationFrame(()=>{scheduled=false;mark(name,doc);});}).observe(doc.body,{childList:true,subtree:true,attributes:true,attributeFilter:name==='dsh'?['disabled','aria-expanded','aria-controls','class','style','hidden']:['disabled','aria-expanded','aria-controls']});
      let dshDrawer=name==='dsh'?doc.documentElement.getAttribute('data-dshm-drawer'):null;
      new doc.defaultView.MutationObserver(()=>{if(name==='dsh'){
        stopDshAnimations(doc,true);
        const next=doc.documentElement.getAttribute('data-dshm-drawer');
        if(next!==dshDrawer){dshDrawer=next;mark(name,doc);}
      }palette();}).observe(doc.documentElement,{attributes:true,attributeFilter:name==='codex'?['class']:name==='dsh'?['class','style','hidden','data-dshm-drawer']:['class','style']});
      if(name==='dsh'){
        // DSH's history pager is a "加载更早" button. Pulling up to the top should
        // load the next page without a tap, matching the other two tabs.
        let lastPagerClick=0;
        doc.addEventListener('scroll',event=>{
          const target=event.target;
          if(current!=='dsh'||document.hidden||doc.hidden||doc.documentElement.getAttribute('data-dshm-drawer')==='open')return;
          if(!target?.matches?.('[data-conversation-scroll],.tnXGgG_scroll')||!Number.isFinite(target.scrollTop)||target.scrollTop>160)return;
          // Match the pinned ChatViewport.attach ownership rule: its shared
          // conversation scrollport, or the inner Chat list when standalone.
          // A textarea, menu, code block or turn rail may scroll inside either;
          // only the owner itself may ask its own top-level history pager to load.
          const history=target.matches('.tnXGgG_scroll')?target:target.querySelector('.tnXGgG_scroll');
          if(!history||(history.closest('[data-conversation-scroll]')||history)!==target)return;
          const button=history.querySelector(':scope > [data-chat-flow] > .tnXGgG_older > button');
          if(!button||button.disabled||!button.offsetParent)return;
          const now=Date.now();
          if(now-lastPagerClick<900)return;
          lastPagerClick=now;button.click();
        },true);
        doc.addEventListener('click',event=>{
          const row=event.target.closest?.('.JoiKIa_projectRow');
          if(!row||event.target.closest?.('button'))return;
          const group=row.closest('.Kjh-qa_groupSection');
          if(group)rememberDshTap(group,row.closest('.Kjh-qa_list'),doc.defaultView);
        },true);
        new doc.defaultView.MutationObserver(palette).observe(doc.body,{attributes:true,attributeFilter:['data-ds-dark-theme']});
        doc.defaultView.matchMedia('(prefers-reduced-motion:reduce)').addEventListener('change',event=>{if(event.matches)stopDshAnimations(doc);});
        doc.addEventListener('visibilitychange',()=>{if(doc.hidden)stopDshAnimations(doc);});
        doc.addEventListener('freeze',()=>stopDshAnimations(doc));
        doc.defaultView.addEventListener('pagehide',()=>stopDshAnimations(doc));
      }
      if(name==='codex')doc.addEventListener('keydown',event=>{
        if(current!=='codex'||event.key!=='Escape')return;
        const original=doc.querySelector('[data-testid="sidebar-view-menu"]');
        if(original?.getAttribute('aria-expanded')!=='true')return;
        doc.defaultView.requestAnimationFrame(()=>doc.defaultView.setTimeout(()=>{
          if(current==='codex'&&original.getAttribute('aria-expanded')!=='true')doc.querySelector('.hub-workspace-view')?.focus({preventScroll:true});
        },0));
      },true);
      if(name==='codex')doc.addEventListener('focusin',event=>{
        const original=doc.querySelector('[data-testid="sidebar-view-menu"]');
        if(current!=='codex'||event.target!==original||original.getAttribute('aria-expanded')==='true')return;
        doc.querySelector('.hub-workspace-view')?.focus({preventScroll:true});
      });
    }
    syncSafeBottom();
    for(const [name,frame] of frames){frame.addEventListener('load',()=>{attach(name);syncSafeBottom();});attach(name);}
    matchMedia('(prefers-color-scheme:dark)').addEventListener('change',palette);
    window.addEventListener('resize',syncSafeBottom);
    window.visualViewport?.addEventListener('resize',syncSafeBottom);
    document.addEventListener('visibilitychange',()=>{if(document.hidden)stopDshAnimations();else syncSafeBottom();});
    document.addEventListener('freeze',()=>stopDshAnimations());
    window.addEventListener('pagehide',()=>stopDshAnimations());
    return name=>{
      if(name!=='dsh')stopDshAnimations();
      current=name;document.documentElement.dataset.active=name;attach(name);palette();
      if(name==='dsh'){
        const doc=docOf(name);
        // The hub reveals its iframe after this callback; measure only once it is visible.
        if(doc?.body)doc.defaultView.requestAnimationFrame(()=>{if(current==='dsh')mark(name,doc);});
      }
    };
  };
})();

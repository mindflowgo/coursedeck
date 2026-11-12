<script>
  import '../../app/src/app.css';
  import { onMount } from 'svelte';
  import HtmlViewer from '../../app/src/lib/components/HtmlViewer.svelte';
  import MarkdownViewer from '../../app/src/lib/components/MarkdownViewer.svelte';
  import FloatingCheckpointTrigger from '../../app/src/lib/components/FloatingCheckpointTrigger.svelte';
  import CheckpointMarker from '../../app/src/lib/components/CheckpointMarker.svelte';
  import CheckpointModal from '../../app/src/lib/components/CheckpointModal.svelte';
  import { anchorAtReaderY } from '../../app/src/lib/checkpoint/selection';

  const renderer = new URLSearchParams(location.search).get('annotations') || 'html';
  const sourceFile = renderer === 'html' ? 'first.lesson.html' : 'first.lesson.companion.md';
  let reader = $state(null);
  let markdown = $state('');
  let checkpoints = $state([]);
  let selection = $state(null);
  let externalPosition = $state(null);
  let lastAnchor = $state(null);
  let positions = $state({});
  let draft = $state(null);
  let openId = $state(null);
  const visible = $derived(checkpoints.filter(cp => cp.anchor.sourceFile === sourceFile));
  onMount(async () => {
    const data = await fetch('/__annotation-state').then(r => r.json());
    markdown = data.markdown;
    checkpoints = data.checkpoints;
  });
  function note(y) {
    const body = reader?.querySelector('.markdown-body');
    const anchor = selection?.anchor || lastAnchor || (body ? anchorAtReaderY(body,reader,y) : {type:'pixel', verticalPosition:y});
    draft = {file:'first.lesson.md', verticalPosition:anchor.verticalPosition, anchor:{...anchor,renderer,sourceFile},selection:selection?.selection};
  }
  async function save(data) {
    await fetch('/api/courses/fixture/annotation-anchors',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file:'first.lesson.md',renderer})});
    const response = await fetch('/api/courses/fixture/checkpoints',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...draft,...data,type:'note'})}).then(r=>r.json());
    checkpoints = [...checkpoints,response.checkpoint];
    selection = null;
  }
  function resolved(cp) {
    return positions[cp.id] ?? cp.verticalPosition;
  }
</script>

<div class="relative mx-auto w-full max-w-5xl h-[650px] mt-16" data-test-reader-host>
  <div class="relative h-full overflow-y-auto overflow-x-hidden pr-12 sm:pl-8 sm:py-8" bind:this={reader} data-test-reader>
    {#each visible as cp (cp.id)}
      <div data-checkpoint-id={cp.id}>
        <CheckpointMarker checkpoint={cp} resolvedTop={resolved(cp)} isOpen={openId===cp.id} onToggle={()=>openId=openId===cp.id?null:cp.id} />
      </div>
    {/each}
    <div class="bg-white border rounded-xl" data-test-page>
      {#if renderer==='html'}
        <HtmlViewer courseId="fixture" lessonId="first" scrollerEl={reader} checkpoints={visible}
          onTextSelected={s=>selection=s} onSelectionCleared={()=>selection=null}
          onMouseMove={p=>{externalPosition=p;lastAnchor=p.anchor;}}
          onMouseLeave={()=>externalPosition=null} onResolveAnchors={p=>positions=p} />
      {:else}
        <div class="p-6">
          <MarkdownViewer {markdown} courseId="fixture" markupScroller={reader} checkpoints={visible}
            onResolveAnchors={p=>positions=p}
            onAnnotationSelect={s=>selection=s} onSelectionCleared={()=>selection=null} />
        </div>
      {/if}
    </div>
  </div>
  <div class="pointer-events-none absolute inset-0">
    <FloatingCheckpointTrigger containerEl={reader} disabled={draft!==null} hasSelection={!!selection} {externalPosition} onTriggerNote={note} />
  </div>
</div>
<CheckpointModal isOpen={draft!==null} checkpoint={draft} onSave={save} onClose={()=>draft=null} />

<script>
  import FloatingCheckpointTrigger from '../../app/src/lib/components/FloatingCheckpointTrigger.svelte';
  import HtmlViewer from '../../app/src/lib/components/HtmlViewer.svelte';
  import AnnotationReader from './AnnotationReader.svelte';
  const annotationMode = new URLSearchParams(location.search).has('annotations');
  const htmlMode = new URLSearchParams(location.search).has('html');
  let lessonId = $state('first');
  let reader = $state(null);
  let externalPosition = $state(null);
  let selection = $state(true);
  let disabled = $state(false);
  $effect(() => {
    window.fixture = {
      external: (cursorY) => { externalPosition = { cursorY, scrollTop: reader.scrollTop }; },
      disable: (value) => { disabled = value; },
      clearExternal: () => { externalPosition = null; }
    };
  });
</script>
{#if annotationMode}
  <AnnotationReader />
{:else if htmlMode}
  <button onclick={() => { lessonId = 'second'; }}>Change synthetic lesson</button>
  <HtmlViewer courseId="fixture" {lessonId} />
{:else}
<div id="fixture" style="position:absolute;top:80px;left:40px;width:800px;height:700px">
  <div id="reader" bind:this={reader} style="position:absolute;top:100px;left:0;width:800px;height:600px;overflow:auto">
    <div style="height:2400px">Synthetic reading content</div>
  </div>
  <div id="overlay" style="position:absolute;inset:0;pointer-events:none">
    <FloatingCheckpointTrigger containerEl={reader} hasSelection={selection} {externalPosition} {disabled}
      onTriggerNote={(y) => { window.lastAction = y; }} />
  </div>
</div>
{/if}

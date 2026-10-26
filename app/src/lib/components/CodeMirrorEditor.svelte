<script lang="ts">
  import { EditorView, drawSelection, dropCursor } from '@codemirror/view';
  import { EditorState } from '@codemirror/state';
  import {
    defaultKeymap,
    history,
    historyKeymap,
    cursorLineBoundaryLeft,
    cursorLineBoundaryRight,
    selectLineBoundaryLeft,
    selectLineBoundaryRight,
    cursorDocStart,
    cursorDocEnd,
    selectDocStart,
    selectDocEnd
  } from '@codemirror/commands';
  import { bracketMatching } from '@codemirror/language';
  import { keymap } from '@codemirror/view';
  import { onMount } from 'svelte';
  import { liveMarkdown } from '$lib/editor';
  import { splitFrontmatter, reappendFrontmatter } from '$lib/parser/frontmatter';

  interface Props {
    value: string;
    courseId?: string;
    preserveFrontmatter?: boolean;
    onChange?: (val: string) => void;
    onSave?: () => void;
  }

  let {
    value,
    courseId = '',
    preserveFrontmatter = true,
    onChange,
    onSave
  }: Props = $props();

  let editorContainer: HTMLDivElement;
  let view: EditorView | null = null;
  let lastValue = '';
  let lastEmittedValue = '';
  let rememberedFrontmatter = '';

  onMount(() => {
    lastValue = value || '';
    lastEmittedValue = lastValue;

    let initialDoc = lastValue;
    if (preserveFrontmatter) {
      const split = splitFrontmatter(lastValue);
      rememberedFrontmatter = split.rawFrontmatter;
      initialDoc = split.body;
    }

    const isolateArrowEvents = EditorView.domEventHandlers({
      keydown(event) {
        if (event.metaKey || event.ctrlKey) {
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            // Stop propagation to prevent any outer/window listeners from intercepting line/doc caret movement
            event.stopPropagation();
          }
        }
        return false;
      }
    });

    const editorNavigationKeymap = keymap.of([
      {
        key: 'Mod-ArrowLeft',
        mac: 'Cmd-ArrowLeft',
        run: cursorLineBoundaryLeft,
        shift: selectLineBoundaryLeft,
        preventDefault: true
      },
      {
        key: 'Mod-ArrowRight',
        mac: 'Cmd-ArrowRight',
        run: cursorLineBoundaryRight,
        shift: selectLineBoundaryRight,
        preventDefault: true
      },
      {
        key: 'Mod-ArrowUp',
        mac: 'Cmd-ArrowUp',
        run: cursorDocStart,
        shift: selectDocStart,
        preventDefault: true
      },
      {
        key: 'Mod-ArrowDown',
        mac: 'Cmd-ArrowDown',
        run: cursorDocEnd,
        shift: selectDocEnd,
        preventDefault: true
      }
    ]);

    const saveKeybinding = keymap.of([
      {
        key: 'Mod-s',
        run: () => {
          if (onSave) onSave();
          return true;
        }
      },
      ...defaultKeymap,
      ...historyKeymap
    ]);

    const state = EditorState.create({
      doc: initialDoc,
      extensions: [
        EditorView.lineWrapping,
        isolateArrowEvents,
        editorNavigationKeymap,
        liveMarkdown({ courseId }),
        history(),
        drawSelection(),
        dropCursor(),
        bracketMatching(),
        saveKeybinding,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const newDoc = update.state.doc.toString();
            const fullDoc = (preserveFrontmatter && rememberedFrontmatter)
              ? reappendFrontmatter(rememberedFrontmatter, newDoc)
              : newDoc;

            lastEmittedValue = fullDoc;
            lastValue = fullDoc;
            if (onChange) {
              onChange(fullDoc);
            }
          }
        }),
      ]
    });

    view = new EditorView({
      state,
      parent: editorContainer
    });

    return () => {
      view?.destroy();
      view = null;
    };
  });

  // Watch for external updates (e.g. switching tabs or lessons)
  $effect(() => {
    const val = value || '';
    if (view && val !== lastValue) {
      lastValue = val;
      // Echo guard: if parent is reflecting back what we just emitted, ignore
      if (val === lastEmittedValue) {
        return;
      }

      let targetDoc = val;
      if (preserveFrontmatter) {
        const split = splitFrontmatter(val);
        rememberedFrontmatter = split.rawFrontmatter;
        targetDoc = split.body;
      }

      const currentDoc = view.state.doc.toString();
      if (targetDoc !== currentDoc) {
        const currentSelection = view.state.selection;
        view.dispatch({
          changes: { from: 0, to: currentDoc.length, insert: targetDoc },
          selection: currentSelection.main.head <= targetDoc.length ? currentSelection : undefined
        });
      }
    }
  });
</script>

<div
  bind:this={editorContainer}
  class="h-full w-full overflow-hidden bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xs focus-within:ring-2 focus-within:ring-amber-500/20 transition"
></div>

<style>
  :global(.cm-editor) {
    height: 100%;
  }
  :global(.cm-scroller) {
    overflow: auto;
  }
</style>

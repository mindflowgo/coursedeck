<script lang="ts">
  import { apiFetch } from '$lib/api';
  import { getActiveLlmCard } from '$lib/llmClient';
  import { queueStatus } from '$lib/queueStatus.svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import Header from '$lib/components/Header.svelte';
  import LessonSelector from '$lib/components/LessonSelector.svelte';
  import MarkdownViewer from '$lib/components/MarkdownViewer.svelte';
  import CodeMirrorEditor from '$lib/components/CodeMirrorEditor.svelte';
  import QuizRunner from '$lib/components/QuizRunner.svelte';
  import UploadModal from '$lib/components/UploadModal.svelte';
  import PromptCard from '$lib/components/PromptCard.svelte';
  import ConfigureLLMModal from '$lib/components/ConfigureLLMModal.svelte';
  import SchedulePreferencesModal from '$lib/components/SchedulePreferencesModal.svelte';
  import type { SchedulePreferences } from '$lib/schedule';
  import ScheduleViewer from '$lib/components/ScheduleViewer.svelte';
  import SelectionToolbar from '$lib/components/SelectionToolbar.svelte';
  import DocumentViewerModal from '$lib/components/DocumentViewerModal.svelte';
  import { parseFrontmatter, serializeWithFrontmatter } from '$lib/parser/frontmatter';
  import { validateScheduleMarkdown } from '$lib/parser/scheduleValidation';
  import { ScheduleParser } from '$lib/parser/scheduleParser';
  import { formatUserNote, insertAnnotationAfterText, removeAnnotation } from '$lib/parser/annotationInserter';
  import type { CourseManifest, CourseManifestLesson } from '$lib/parser/courseIngest';
  import type { LessonContentBundle } from '$lib/server/courses';
  import {
    isCustomTabSlug,
    isTabSlug,
    isCourseTab,
    customTabDisplayName,
    validateTabName,
    slugifyTabName,
    starterPromptForTab
  } from '$lib/tabs';
  import { onMount, onDestroy, untrack } from 'svelte';
  import {
    ArrowUp,
    BookOpen,
    FileText,
    ListCollapse,
    Sparkles,
    CheckCircle2,
    Eye,
    Edit3,
    Save,
    RotateCw,
    Download,
    CalendarDays,
    AlertTriangle,
    Layers,
    Loader2,
    Check,
    Plus,
    X,
    RefreshCw,
    FileDown
  } from 'lucide-svelte';
  import { exportDocumentToPdf } from '$lib/pdf/exportPdf';
  import { schedulePdfPrewarm } from '$lib/pdf/pdfClient';
  import { afterPaint, installPerfObservers, perf } from '$lib/perf';
  import { scrollMemoryKey, recallScroll, rememberScroll } from '$lib/scrollMemory';

  let courseId = $derived($page.params.course_id);
  let course: CourseManifest | null = $state(null);
  let selectedLessonId: string = $state('');
  // Tab slugs: built-ins (lesson/summary/cheatsheet/test), course-scope
  // schedule, and per-lesson custom tabs discovered from tab files on disk.
  type PageTab = string;
  let activeTab: PageTab = $state('lesson');
  let isEditing: boolean = $state(false);
  let isUploadModalOpen: boolean = $state(false);
  let uploadModalMode: 'add' | 'replace' = $state('add');
  let isLLMModalOpen: boolean = $state(false);
  let isScheduleModalOpen: boolean = $state(false);
  let isGeneratingAI: boolean = $state(false);

  // Complete course scope states
  let isCourseScope: boolean = $state(false);
  let isLoadingCourseDoc: boolean = $state(false);
  let isGeneratingCourseDoc: boolean = $state(false);
  let quizRunnerKey: number = $state(0);

  // Lesson bundle and generic prompt templates
  let lessonBundle: LessonContentBundle | null = $state(null);
  let genericPrompts: Record<string, string> = $state({});

  // Custom tabs discovered from this lesson's tab files on disk
  let customTabs = $derived.by(() => {
    if (!lessonBundle) return [];
    return Object.keys(lessonBundle.tabs)
      .filter((slug) => isCustomTabSlug(slug))
      .sort();
  });

  // Custom course tabs discovered from course.*.md files on disk
  let courseCustomTabs = $derived.by(() => {
    const docs = course?.courseDocs;
    if (!docs) return [];
    return Object.keys(docs)
      .filter((slug) => isCustomTabSlug(slug) && Boolean(docs[slug]))
      .sort();
  });

  function hasCourseDoc(tab: string): boolean {
    if (tab === 'lesson') return true;
    if (['summary', 'cheatsheet', 'test', 'schedule'].includes(tab)) return true;
    const docs = course?.courseDocs;
    return Boolean(docs && docs[tab]);
  }

  // New-tab modal state
  let isNewTabModalOpen = $state(false);
  let newTabName = $state('');
  let newTabError = $state('');
  let isCreatingTab = $state(false);

  // Current tab contents (raw markdown including frontmatter)
  let tabContents: Record<string, string> = $state({
    lesson: '',
    summary: '',
    cheatsheet: '',
    test: '',
    schedule: ''
  });

  let originalContents: Record<string, string> = $state({
    lesson: '',
    summary: '',
    cheatsheet: '',
    test: '',
    schedule: ''
  });

  let isLoadingCourse = $state(true);
  let isLoadingLesson = $state(false);
  let isSaving = $state(false);
  let saveSuccessMessage = $state('');
  let isExportingPdf = $state(false);

  // ---- Workspace scroll memory -------------------------------------------
  // Every course/lesson/tab page remembers its own offset (tab_scroll:*), so
  // switching tabs lands at the top for a first visit and back where the
  // reader stopped on later ones.
  let contentScroller = $state<HTMLDivElement | undefined>();
  let showScrollTop = $state(false);
  const SCROLL_TOP_BUTTON_AFTER = 400;
  const SCROLL_SAVE_DEBOUNCE_MS = 200;
  let scrollSaveTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingScroll: { key: string; top: number } | null = null;

  function currentScrollKey(): string {
    return scrollMemoryKey(courseId || '', isCourseScope ? 'course' : selectedLessonId, activeTab);
  }

  function handleContentScroll() {
    if (!contentScroller) return;
    const top = contentScroller.scrollTop;
    showScrollTop = top > SCROLL_TOP_BUTTON_AFTER;
    // Content swaps replace the page with a short loading spinner, which
    // clamps scrollTop to 0 — that is not the reader scrolling to the top,
    // so don't let it overwrite their remembered offset.
    if (isCourseScope ? isLoadingCourseDoc : isLoadingLesson) return;
    // Capture key+offset now: by the time the debounce fires the user may be
    // on another tab, and the write must target the page that was scrolled.
    pendingScroll = { key: currentScrollKey(), top };
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(flushPendingScroll, SCROLL_SAVE_DEBOUNCE_MS);
  }

  function flushPendingScroll() {
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = undefined;
    if (pendingScroll) {
      rememberScroll(pendingScroll.key, pendingScroll.top);
      pendingScroll = null;
    }
  }

  function scrollWorkspaceToTop() {
    contentScroller?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Land the page now on screen at its remembered offset once its content is
  // in the DOM ($effect runs after updates; course docs arrive async, hence
  // the loading gate). Pages never scrolled start at the top.
  $effect(() => {
    const key = currentScrollKey();
    const isLoading = isCourseScope ? isLoadingCourseDoc : isLoadingLesson;
    if (isLoading || !contentScroller) return;
    contentScroller.scrollTop = recallScroll(key);
    showScrollTop = contentScroller.scrollTop > SCROLL_TOP_BUTTON_AFTER;
  });

  // Default prompt for active tab
  let defaultPromptForActiveTab = $derived.by(() => {
    if (activeTab === 'lesson') return '';
    if (isCourseScope) {
      return genericPrompts[`course_${activeTab}`] || genericPrompts[activeTab] || '';
    }
    return genericPrompts[activeTab] || '';
  });

  // Parsed frontmatter and markdown body for current tab
  let parsedActiveTab = $derived.by(() => {
    const raw = tabContents[activeTab] || '';
    return parseFrontmatter(raw, defaultPromptForActiveTab);
  });

  // Display name for active tab
  let tabDisplayName = $derived.by(() => {
    if (activeTab === 'summary') return 'Summary';
    if (activeTab === 'cheatsheet') return 'Cheatsheet';
    if (activeTab === 'test') return 'Practice Test';
    if (activeTab === 'schedule') return 'Schedule';
    if (isCustomTabSlug(activeTab)) return customTabDisplayName(activeTab);
    return isCourseScope ? 'Course Notes' : 'Notes';
  });

  // Check if current tab has unsaved changes
  let hasUnsavedChanges = $derived(
    tabContents[activeTab] !== originalContents[activeTab]
  );

  async function loadPrompts() {
    try {
      const res = await apiFetch('/api/prompts');
      if (res.ok) {
        const data = await res.json();
        const map: Record<string, string> = {};
        for (const p of data.prompts || []) {
          map[p.id] = p.content;
        }
        genericPrompts = map;
      }
    } catch (e) {
      console.warn('Failed to load prompts template:', e);
    }
  }

  async function loadCourse(selectTargetLessonId?: string, opts?: { skipAutoLesson?: boolean }) {
    isLoadingCourse = true;
    try {
      const res = await apiFetch(`/api/courses/${courseId}`);
      if (res.ok) {
        const data = await res.json();
        course = data.course;
        if (!opts?.skipAutoLesson && !isCourseScope && course && course.units.length > 0 && course.units[0].lessons.length > 0) {
          const target = selectTargetLessonId || selectedLessonId || course.units[0].lessons[0].id;
          await loadLesson(target);
        }
      }
    } catch (e) {
      console.error('Failed to load course:', e);
    } finally {
      isLoadingCourse = false;
    }
  }

  async function loadCourseDocument(tab: PageTab) {
    isLoadingCourseDoc = true;
    const startedAt = performance.now();
    try {
      if (tab === 'lesson') {
        const res = await apiFetch(`/api/courses/${courseId}/course-docs?type=notes`);
        const fetchMs = performance.now() - startedAt;
        if (res.ok) {
          const data = await res.json();
          const parsedMs = performance.now() - startedAt;
          tabContents.lesson = data.markdown || '';
          originalContents.lesson = tabContents.lesson;
          const stateMs = performance.now() - startedAt;
          perf(
            'course-notes-load',
            {
              tab,
              fetchMs: +fetchMs.toFixed(1),
              jsonParseMs: +(parsedMs - fetchMs).toFixed(1),
              stateSetMs: +stateMs.toFixed(1),
              chars: (data.markdown || '').length,
              contentLength: Number(res.headers.get('content-length') || 0)
            },
            `[PERF][course-notes-load] fetch=${fetchMs.toFixed(0)}ms jsonParse=${(parsedMs - fetchMs).toFixed(0)}ms ` +
              `stateSet=${stateMs.toFixed(0)}ms chars=${(data.markdown || '').length.toLocaleString()}`
          );
          afterPaint(() => {
            const visibleMs = performance.now() - startedAt;
            perf(
              'course-notes-visible',
              { tab, visibleMs: +visibleMs.toFixed(1), chars: (data.markdown || '').length },
              `[PERF][course-notes-visible] aggregate painted ${visibleMs.toFixed(0)}ms after the request started ` +
                `(of which ${(visibleMs - stateMs).toFixed(0)}ms was markdown render + layout + paint)`
            );
          });
        }
      } else {
        const res = await apiFetch(`/api/courses/${courseId}/course-docs?type=${tab}`);
        if (res.ok) {
          const data = await res.json();
          if (data.exists && data.markdown && data.markdown.trim().length > 0) {
            tabContents[tab] = data.markdown;
            originalContents[tab] = data.markdown;
          } else if (tab === 'schedule') {
            // Schedules need the preferences questionnaire first — show the
            // intro panel instead of silently calling the LLM.
            tabContents.schedule = '';
            originalContents.schedule = '';
          } else if (['summary', 'cheatsheet', 'test'].includes(tab)) {
            // Built-in course doc not yet generated: auto-trigger generation
            isLoadingCourseDoc = false;
            await generateCourseDocument(tab);
            return;
          } else {
            // Custom course tab does not exist on disk: safely fall back to lesson
            activeTab = 'lesson';
            await loadCourseDocument('lesson');
            const targetUrl = `/courses/${(courseId || '').toLowerCase()}/course`;
            if ($page.url.pathname !== targetUrl) {
              nav(targetUrl, { replace: true });
            }
            return;
          }
        }
      }
    } catch (e) {
      console.error(`Failed to load course document ${tab}:`, e);
    } finally {
      isLoadingCourseDoc = false;
    }
  }

  async function enqueueScheduleGeneration(promptWithPreferences: string, preferences?: SchedulePreferences) {
    const activeModel = await getActiveLlmCard();
    if (!activeModel?.baseUrl) {
      isLLMModalOpen = true;
      return;
    }

    if (!promptWithPreferences || promptWithPreferences.trim().length === 0) {
      alert(
        'Core prompt template for course schedule is missing. Please add course_schedule_enrichment.md in Prompts before generating.'
      );
      return;
    }

    // Show the user exactly what is being fed to the AI (browser console).
    const marker = 'STUDENT PREFERENCES (authoritative):';
    const markerAt = promptWithPreferences.indexOf(marker);
    const templateChars = markerAt >= 0 ? markerAt + marker.length : promptWithPreferences.length;
    const prefLines = markerAt >= 0 ? promptWithPreferences.slice(templateChars) : '';
    const prefItems = prefLines
      ? prefLines
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      : [];

    let schedulePreview: { payload?: string; stats?: any } | null = null;
    try {
      const previewRes = await apiFetch(`/api/courses/${courseId}/course-docs?type=schedule&preview=true`);
      if (previewRes.ok) {
        schedulePreview = await previewRes.json();
      }
    } catch (e) {
      console.warn('[Schedule AI] Could not pre-fetch payload preview:', e);
    }

    const payloadChars = schedulePreview?.stats?.payloadChars ?? schedulePreview?.payload?.length ?? 0;
    const payloadEstTokens = Math.round(payloadChars / 4);
    const systemEstTokens = Math.round(promptWithPreferences.length / 4);
    const totalEstTokens = systemEstTokens + payloadEstTokens;

    console.group(
      `[Schedule AI] Data being sent to AI for ${(courseId || '').toUpperCase()} (${(promptWithPreferences.length + payloadChars).toLocaleString()} chars, ~${totalEstTokens.toLocaleString()} tokens)`
    );
    console.log('Target Model & Endpoint:', {
      model: activeModel.model || activeModel.label || '(server default)',
      provider: activeModel.provider,
      baseUrl: activeModel.baseUrl
    });
    console.log(`1. System Prompt (${promptWithPreferences.length.toLocaleString()} chars, ~${systemEstTokens.toLocaleString()} tokens):`, {
      templateChars,
      studentPreferences: prefItems.length > 0 ? prefItems : '(none — template only)'
    });
    console.log(`2. Course Payload (${payloadChars.toLocaleString()} chars, ~${payloadEstTokens.toLocaleString()} tokens):`, {
      lessons: schedulePreview?.stats?.lessons,
      assignments: schedulePreview?.stats?.assignments,
      totalContentWords: schedulePreview?.stats?.totalWords,
      densityMix: schedulePreview?.stats?.density
    });
    if (schedulePreview?.stats?.items && schedulePreview.stats.items.length > 0) {
      console.log(`3. Itemized Course Breakdown (${schedulePreview.stats.items.length} items):`);
      console.table(
        schedulePreview.stats.items.map((it: any) => ({
          'Lesson ID': it.lessonId,
          'Unit': it.unitNumber,
          'Title': it.lessonTitle,
          'Kind': it.type,
          'Words': it.words,
          'Density': it.density || 'none',
          'Excerpt Chars': it.excerptChars
        }))
      );
    }
    console.groupEnd();

    try {
      const res = await apiFetch('/api/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'enqueue',
          courseId,
          tab: 'schedule',
          lessonId: 'schedule',
          lessonTitle: 'Course Study Schedule',
          customPrompt: promptWithPreferences,
          preferences
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || 'Failed to queue schedule generation');
      }

      const data = await res.json();
      const count = data.enqueued?.length || 0;
      if (count === 0) {
        saveSuccessMessage = '⏳ Schedule is already queued or generating — watch the AI Queue for progress.';
      } else {
        saveSuccessMessage = '✨ Queued Course Schedule for background generation!';
      }
      setTimeout(() => {
        saveSuccessMessage = '';
      }, 4000);

      await queueStatus.refresh();
    } catch (err: any) {
      alert('AI Schedule Queue Error: ' + (err?.message || 'Check your LLM configuration.'));
    }
  }

  async function generateCourseDocument(type: PageTab, opts?: { customPrompt?: string }) {
    if (type === 'lesson' || !['summary', 'cheatsheet', 'test', 'schedule'].includes(type)) return;

    const promptKey = type === 'schedule' ? 'course_schedule_enrichment' : `course_${type}`;
    const activePrompt =
      opts?.customPrompt ||
      parsedActiveTab.frontmatter.prompt ||
      genericPrompts[promptKey] ||
      genericPrompts[type] ||
      '';

    if (type === 'schedule') {
      await enqueueScheduleGeneration(activePrompt);
      return;
    }

    const activeModel = await getActiveLlmCard();
    if (!activeModel?.baseUrl) {
      isLLMModalOpen = true;
      return;
    }

    if (!activePrompt || activePrompt.trim().length === 0) {
      alert(
        `Core prompt template for "${type}" is missing. Please add or verify ${promptKey}.md in the Prompts settings before generating.`
      );
      return;
    }

    isGeneratingCourseDoc = true;
    try {
      const res = await apiFetch(`/api/courses/${courseId}/course-docs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          forceRegenerate: true,
          customPrompt: activePrompt,
          async: true
        })
      });

      if (!res.ok) {
        let errorMsg = '';
        try {
          const errData = await res.json();
          errorMsg = errData.message || errData.error || errData.detail || '';
        } catch {
          errorMsg = (await res.text().catch(() => '')).trim();
        }
        if (!errorMsg) {
          errorMsg = `Failed to generate course ${type} (HTTP ${res.status})`;
        }
        throw new Error(errorMsg);
      }

      const initialData = await res.json();
      let data = initialData;
      let generatedMarkdown = initialData.markdown || '';

      if (initialData.status === 'generating') {
        const pollInterval = 1500;
        const maxWaitMs = 360_000; // 6 minutes max
        const startTime = Date.now();
        let lastStatus = 'generating';

        while (true) {
          await new Promise((r) => setTimeout(r, pollInterval));
          if (Date.now() - startTime > maxWaitMs) {
            // The server-side job keeps running after we stop polling — the
            // unfinished doc usually lands anyway, so say so instead of
            // telling the user the generation is simply dead.
            throw new Error(
              `Generation has not finished after 6 minutes (last status: ${lastStatus}). It will keep running in the background — check the AI Queue, or reload this tab shortly.`
            );
          }

          const pollRes = await apiFetch(`/api/courses/${courseId}/course-docs?type=${type}&status=true`);
          if (!pollRes.ok) {
            const errData = await pollRes.json().catch(() => ({}));
            throw new Error(errData.error || errData.message || `Generation failed (HTTP ${pollRes.status})`);
          }

          const pollData = await pollRes.json();
          if (pollData.status === 'generating') {
            lastStatus = `generating ${Math.round((Date.now() - startTime) / 1000)}s elapsed${typeof pollData.elapsedMs === 'number' ? `, server ${Math.round(pollData.elapsedMs / 1000)}s` : ''}`;
          } else {
            lastStatus = String(pollData.status);
          }
          if (pollData.status === 'completed') {
            data = pollData;
            generatedMarkdown = pollData.markdown || '';
            break;
          } else if (pollData.status === 'failed') {
            throw new Error(pollData.error || `Failed to generate course ${type}`);
          }
          // Still generating, continue polling
        }
      }

      console.log(`[Course AI] Generated course ${type}: ${generatedMarkdown.length} chars`, {
        usage: data.usage
      });

      tabContents[type] = generatedMarkdown;
      tabContents = { ...tabContents };
      originalContents[type] = generatedMarkdown;
      originalContents = { ...originalContents };

      if (type === 'test') {
        quizRunnerKey++;
      }

      if (course) {
        if (!course.courseDocs) {
          course.courseDocs = { summary: false, cheatsheet: false, test: false, schedule: false };
        }
        (course.courseDocs as unknown as Record<string, boolean>)[type] = true;
      }

      saveSuccessMessage = `✨ Generated course ${tabDisplayName}!`;
      setTimeout(() => {
        saveSuccessMessage = '';
      }, 3500);
    } catch (err: any) {
      console.error(`Failed to generate course ${type}:`, err);
      const detail = err?.message || 'Check your LLM configuration or server logs.';
      alert(`AI Course Document Error: ${detail}`);
    } finally {
      isGeneratingCourseDoc = false;
    }
  }

  /**
   * goto wrapper that traces every in-app navigation ([NAV] in the console).
   * User-initiated navigations PUSH a history entry (so the Header back
   * button can retrace them); mechanical rewrites — syncRoute's URL
   * canonicalization and not-found fallbacks — pass { replace: true } so
   * they never add redundant entries.
   */
  function nav(targetUrl: string, opts?: { replace?: boolean }) {
    const replace = opts?.replace === true;
    console.log(
      `[NAV] goto ${targetUrl} ${replace ? '(replace)' : '(push)'} (from ${$page.url.pathname}${$page.url.search})`
    );
    goto(targetUrl, { replaceState: replace, noScroll: true, keepFocus: true });
  }

  function switchTab(tab: PageTab) {
    console.log(`[NAV] switchTab "${tab}" | scope=${isCourseScope} lesson=${selectedLessonId}`);
    if (isCourseScope && !hasCourseDoc(tab)) {
      console.log(`[NAV] switchTab: "${tab}" has no course doc → falling back to lesson`);
      tab = 'lesson';
    }
    activeTab = tab;
    isEditing = false;
    const tabSuffix = tab !== 'lesson' ? `/${tab}` : '';
    if (isCourseScope) {
      loadCourseDocument(tab);
      const targetUrl = `/courses/${(courseId || '').toLowerCase()}/course${tabSuffix}`;
      if ($page.url.pathname !== targetUrl) {
        nav(targetUrl);
      }
    } else {
      if (selectedLessonId) {
        const targetUrl = `/courses/${(courseId || '').toLowerCase()}/${encodeURIComponent(selectedLessonId)}${tabSuffix}`;
        if ($page.url.pathname !== targetUrl) {
          nav(targetUrl);
        }
      }
    }
  }

  async function selectLesson(lessonId: string) {
    console.log(
      `[NAV] selectLesson "${lessonId}" | from "${selectedLessonId}" | tab=${activeTab} scope=${isCourseScope} editing=${isEditing}`
    );
    isCourseScope = false;
    isEditing = false;
    // Schedule is course-only; custom tabs are checked against file existence in loadLesson.
    if (activeTab === 'schedule') {
      activeTab = 'lesson';
    }
    await loadLesson(lessonId);
    console.log(`[NAV] selectLesson loaded → tab=${activeTab}`);
    const targetTab = activeTab;
    const tabSuffix = targetTab && targetTab !== 'lesson' ? `/${targetTab}` : '';
    const targetUrl = `/courses/${(courseId || '').toLowerCase()}/${encodeURIComponent(lessonId)}${tabSuffix}`;
    if ($page.url.pathname !== targetUrl) {
      nav(targetUrl);
    } else {
      console.log(`[NAV] selectLesson: URL already ${targetUrl}, no goto needed`);
    }
  }

  function selectCourseMode() {
    console.log(`[NAV] selectCourseMode | from lesson=${selectedLessonId} tab=${activeTab}`);
    isCourseScope = true;
    isEditing = false;
    if (!hasCourseDoc(activeTab)) {
      activeTab = 'lesson';
    }
    loadCourseDocument(activeTab);
    const targetTab = activeTab;
    const tabSuffix = targetTab && targetTab !== 'lesson' ? `/${targetTab}` : '';
    const targetUrl = `/courses/${(courseId || '').toLowerCase()}/course${tabSuffix}`;
    if ($page.url.pathname !== targetUrl) {
      nav(targetUrl);
    }
  }

  /** Monotonic token for loadLesson calls — the newest invocation wins. */
  let lessonLoadSeq = 0;

  /** Loose lesson-ref equality tolerating zero-padding ("1.2" ≡ "01.02"). */
  function sameLessonRef(a: string | undefined, b: string): boolean {
    if (!a) return false;
    const norm = (s: string) => {
      const m = s.toLowerCase().match(/^(\d+)\.(\d+)(.*)$/);
      return m ? `${m[1].padStart(2, '0')}.${m[2].padStart(2, '0')}${m[3]}` : s.toLowerCase();
    };
    return norm(a) === norm(b);
  }

  async function loadLesson(lessonId: string) {
    const seq = ++lessonLoadSeq;
    console.log(`[NAV] loadLesson "${lessonId}" …`);
    selectedLessonId = lessonId;
    isLoadingLesson = true;
    try {
      const res = await apiFetch(`/api/courses/${courseId}/${lessonId}`);

      // A stale run (e.g. syncRoute captured before a user click) may still
      // be mid-fetch when the user navigates. Discard its result when a newer
      // load has started AND the URL no longer points at this lesson —
      // otherwise it would clobber the freshly loaded lesson's content.
      if (seq !== lessonLoadSeq && !sameLessonRef($page.params.lesson, lessonId)) {
        console.log(`[NAV] loadLesson "${lessonId}" result discarded (superseded by a newer load)`);
        return;
      }

      if (res.ok) {
        const data: LessonContentBundle = await res.json();
        lessonBundle = data;
        selectedLessonId = lessonId;

        // A custom tab that has no file for this lesson cannot stay active
        // (e.g. after switching lessons or deleting the file).
        if (isCustomTabSlug(activeTab) && !data.tabs[activeTab]) {
          console.log(`[NAV] loadLesson: active tab "${activeTab}" has no file here → falling back to lesson`);
          activeTab = 'lesson';
        }

        tabContents = {
          lesson: data.lesson || '',
          ...data.tabs
        };
        originalContents = { ...tabContents };
        console.log(`[NAV] loadLesson "${lessonId}" ✓ tabs=[${Object.keys(data.tabs).join(', ') || 'none'}]`);
      } else {
        console.warn(`[NAV] loadLesson "${lessonId}" failed: HTTP ${res.status}`);
      }
    } catch (e) {
      console.error('Failed to load lesson:', e);
    } finally {
      isLoadingLesson = false;
    }
  }

  /**
   * Creates a custom tab file for the current lesson (`<lesson>.<slug>.md`)
   * with a starter prompt in its frontmatter, seeds the shared prompt
   * template on first use, then selects the new tab.
   */
  async function createCustomTab(slug: string, displayName: string): Promise<boolean> {
    if (!selectedLessonId || isCreatingTab) return false;
    isCreatingTab = true;
    try {
      const prompt = genericPrompts[slug]?.trim() || starterPromptForTab(displayName);
      const content = serializeWithFrontmatter(
        {
          prompt,
          type: slug,
          updatedAt: new Date().toISOString().split('T')[0]
        },
        `# ${currentLessonTitle || selectedLessonId} — ${displayName}\n\n*Empty tab — use the prompt above to generate content with AI, or click Edit to write it manually.*\n`
      );

      const res = await apiFetch(`/api/courses/${courseId}/${selectedLessonId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tab: slug, content })
      });
      if (!res.ok) {
        throw new Error((await res.text().catch(() => '')) || `Failed to create ${displayName} tab`);
      }

      // Seed the shared prompt template so other lessons with this tab name
      // (and the Prompts settings page) reuse it.
      if (!genericPrompts[slug]) {
        const seedRes = await apiFetch('/api/prompts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: slug, content: prompt })
        });
        if (seedRes.ok) {
          genericPrompts = { ...genericPrompts, [slug]: prompt };
        }
      }

      await loadLesson(selectedLessonId);
      activeTab = slug;
      const targetUrl = `/courses/${(courseId || '').toLowerCase()}/${encodeURIComponent(selectedLessonId)}/${slug}`;
      if ($page.url.pathname !== targetUrl) {
        nav(targetUrl);
      }
      saveSuccessMessage = `Created ${displayName} tab!`;
      setTimeout(() => {
        saveSuccessMessage = '';
      }, 2500);
      return true;
    } catch (e: any) {
      console.error('Failed to create tab:', e);
      alert(e?.message || `Failed to create ${displayName} tab`);
      return false;
    } finally {
      isCreatingTab = false;
    }
  }

  function openNewTabModal() {
    newTabName = '';
    newTabError = '';
    isNewTabModalOpen = true;
  }

  function handleCreateTabFromModal() {
    const existing = Object.keys(lessonBundle?.tabs || {});
    const validation = validateTabName(newTabName, existing);
    if (!validation.ok) {
      newTabError = validation.error;
      return;
    }
    isNewTabModalOpen = false;
    const { slug } = validation;
    createCustomTab(slug, customTabDisplayName(slug));
  }

  async function handleDeleteCustomTab(slug: string) {
    if (!selectedLessonId || !isCustomTabSlug(slug)) return;
    const name = customTabDisplayName(slug);
    if (!confirm(`Delete the "${name}" tab for lesson ${selectedLessonId}? This removes ${selectedLessonId}.${slug}.md from disk.`)) {
      return;
    }
    try {
      const res = await apiFetch(`/api/courses/${courseId}/${selectedLessonId}?tab=${slug}`, {
        method: 'DELETE'
      });
      if (!res.ok) {
        throw new Error((await res.text().catch(() => '')) || `Failed to delete ${name} tab`);
      }
      const wasActive = activeTab === slug;
      await loadLesson(selectedLessonId);
      if (wasActive && activeTab === 'lesson') {
        const targetUrl = `/courses/${(courseId || '').toLowerCase()}/${encodeURIComponent(selectedLessonId)}`;
        if ($page.url.pathname !== targetUrl) {
          nav(targetUrl);
        }
      }
      saveSuccessMessage = `Deleted ${name} tab`;
      setTimeout(() => {
        saveSuccessMessage = '';
      }, 2500);
    } catch (e: any) {
      console.error('Failed to delete tab:', e);
      alert(e?.message || `Failed to delete ${name} tab`);
    }
  }

  /** Checkbox toggle from ScheduleViewer: update content, persist via the course-doc PUT. */
  async function handleScheduleToggle(updatedMarkdown: string) {
    tabContents.schedule = updatedMarkdown;
    tabContents = { ...tabContents };
    await saveCurrentTab();
  }

  /** Regenerate the schedule through the preferences questionnaire. */
  function handleScheduleRebuild() {
    isScheduleModalOpen = true;
  }

  function handleScheduleGenerate(promptWithPreferences: string, preferences?: SchedulePreferences) {
    enqueueScheduleGeneration(promptWithPreferences, preferences);
  }

  // Advisory schedule checks (coverage, unknown ids, dates) run against the
  // current file — after generation AND after hand edits.
  let scheduleWarningsDismissed = $state(false);
  let scheduleWarnings = $derived.by(() => {
    if (activeTab !== 'schedule' || !isCourseScope || !course) return [];
    if (tabContents.schedule.trim().length === 0) return [];
    try {
      return validateScheduleMarkdown(tabContents.schedule, course).warnings;
    } catch {
      return [];
    }
  });

  $effect(() => {
    void tabContents.schedule;
    scheduleWarningsDismissed = false;
  });

  async function saveCurrentTab() {
    if (isCourseScope) {
      if (activeTab === 'lesson') return; // Notes cannot be edited
      isSaving = true;
      try {
        const res = await apiFetch(`/api/courses/${courseId}/course-docs`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: activeTab,
            content: tabContents[activeTab]
          })
        });
        if (res.ok) {
          originalContents[activeTab] = tabContents[activeTab];
          saveSuccessMessage = 'Saved!';
          setTimeout(() => {
            saveSuccessMessage = '';
          }, 2000);
        } else {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.message || 'Failed to save course document');
        }
      } catch (e: any) {
        console.error('Failed to save course doc:', e);
        alert(e?.message || 'Failed to save course document');
      } finally {
        isSaving = false;
      }
      return;
    }

    if (!selectedLessonId) return;
    if (activeTab === 'schedule') return; // Schedule is course-scoped, never saved per-lesson
    isSaving = true;

    try {
      const res = await apiFetch(`/api/courses/${courseId}/${selectedLessonId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tab: activeTab,
          content: tabContents[activeTab]
        })
      });

      if (res.ok) {
        originalContents[activeTab] = tabContents[activeTab];
        saveSuccessMessage = 'Saved!';
        setTimeout(() => {
          saveSuccessMessage = '';
        }, 2000);
        // Silently reload lesson bundle to sync tab discovery
        const reloadRes = await apiFetch(`/api/courses/${courseId}/${selectedLessonId}`);
        if (reloadRes.ok) {
          lessonBundle = await reloadRes.json();
        }
      }
    } catch (e) {
      console.error('Failed to save tab:', e);
    } finally {
      isSaving = false;
    }
  }

  function handleEditorChange(newVal: string) {
    tabContents[activeTab] = newVal;
  }

  function handlePromptChange(newPrompt: string) {
    if (activeTab === 'lesson') return;
    const currentParsed = parsedActiveTab;
    const updatedFrontmatter = {
      ...currentParsed.frontmatter,
      prompt: newPrompt,
      updatedAt: new Date().toISOString().split('T')[0]
    };
    tabContents[activeTab] = serializeWithFrontmatter(updatedFrontmatter, currentParsed.body);
  }

  function handleBodyChange(newBody: string) {
    if (activeTab === 'lesson') {
      tabContents[activeTab] = newBody;
      return;
    }
    const currentParsed = parsedActiveTab;
    tabContents[activeTab] = serializeWithFrontmatter(currentParsed.frontmatter, newBody);
  }

  async function triggerAIGeneration() {
    if (activeTab === 'lesson') return;

    const activeModel = await getActiveLlmCard();
    if (!activeModel?.baseUrl) {
      isLLMModalOpen = true;
      return;
    }

    try {
      const activeSystemPrompt = parsedActiveTab.frontmatter.prompt || defaultPromptForActiveTab;

      console.log(`\n[ILC AI Enqueue: ${tabDisplayName}]`);
      console.log(`- Course: ${(courseId || '').toUpperCase()} | Lesson: ${selectedLessonId} (${currentLessonTitle})`);
      console.log(`- Endpoint: ${activeModel.baseUrl}`);
      console.log(`- Model: ${activeModel.model || '(server default)'}`);
      console.log(`- System Prompt: "${activeSystemPrompt.slice(0, 120)}..."`);

      const res = await apiFetch('/api/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'enqueue',
          courseId,
          lessonId: selectedLessonId,
          lessonTitle: currentLessonTitle,
          tab: activeTab,
          customPrompt: activeSystemPrompt
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[ILC AI Enqueue Error]`, errText);
        throw new Error(errText || 'Failed to queue generation task');
      }

      const data = await res.json();
      const enqueuedCount: number = data.enqueued?.length ?? 0;

      if (enqueuedCount === 0) {
        // The queue silently deduplicates against an identical task that is
        // already pending or processing — say so instead of pretending.
        console.log('[ILC AI Enqueue] An identical task is already queued or generating — nothing new added.');
        saveSuccessMessage = `⏳ ${tabDisplayName} is already queued or generating — watch the AI Queue for progress.`;
        setTimeout(() => {
          saveSuccessMessage = '';
        }, 4000);
        return;
      }

      console.log(`[ILC AI Enqueue Success] ${tabDisplayName} task added to background queue (task id: ${data.enqueued[0].id}).`);

      saveSuccessMessage = `✨ Queued ${tabDisplayName} for generation!`;

      setTimeout(() => {
        saveSuccessMessage = '';
      }, 3500);

      // Wake the shared queue poller so status (and console logs from the
      // backend worker) appear immediately.
      queueStatus.refresh();
    } catch (err: any) {
      alert('AI Generation Queue Error: ' + (err?.message || 'Check your LLM configuration.'));
    }
  }

  /**
   * Event-driven generation feedback: the shared queueStatus store polls the
   * backend once for everyone and emits finished tasks; we just toast the
   * outcome for this course. Lesson content refresh goes through the Header's
   * onLessonUpdated callback (wired via AIQueuePopover).
   */
  let releaseQueueWatch: (() => void) | null = null;
  let unsubscribeQueueFinished: (() => void) | null = null;

  function startQueueFeedback(): void {
    releaseQueueWatch = queueStatus.acquire();
    unsubscribeQueueFinished = queueStatus.onTaskFinished(async (task) => {
      if (task.courseId !== (courseId || '').toLowerCase()) return;
      const label = task.tab === 'schedule' ? 'Course Schedule' : (task.tab.charAt(0).toUpperCase() + task.tab.slice(1));
      if (task.status === 'completed') {
        console.log(`[ILC AI Done] ${label} for ${task.lessonId} generated.`);
        saveSuccessMessage = `✨ ${label} generated!`;
        setTimeout(() => {
          saveSuccessMessage = '';
        }, 3500);

        if (task.tab === 'schedule') {
          await loadCourseDocument('schedule');
          if (course) {
            if (!course.courseDocs) {
              course.courseDocs = { summary: false, cheatsheet: false, test: false, schedule: false };
            }
            course.courseDocs.schedule = true;
          }

          const generatedMarkdown = tabContents.schedule;
          if (generatedMarkdown && generatedMarkdown.trim().length > 0) {
            const parsed = ScheduleParser.parseMarkdown(generatedMarkdown);
            console.group(
              `%c[Schedule AI] Generation complete: ${generatedMarkdown.length.toLocaleString()} chars (~${Math.round(generatedMarkdown.length / 4).toLocaleString()} tokens) | ${parsed.events.length} events parsed`,
              'color: #059669; font-weight: bold;'
            );
            console.log('Result Summary:', {
              outputChars: generatedMarkdown.length,
              outputEstTokens: Math.round(generatedMarkdown.length / 4),
              parsedEventsCount: parsed.events.length,
              title: parsed.title,
              summaryLine: parsed.summaryLine,
              tokensUsed: task.tokensUsed
            });

            if (parsed.events.length > 0) {
              console.groupCollapsed(`Itemized Schedule Events (${parsed.events.length} items):`);
              console.table(
                parsed.events.map((e) => ({
                  Date: e.date,
                  Day: e.dayLabel || '—',
                  Type: e.type,
                  Lesson: `${e.lessonId}${e.section ? `/${e.section}` : ''}`,
                  Title: e.title,
                  Duration: e.durationMin ? `${e.durationMin}m` : '—',
                  Focus: e.description || '—'
                }))
              );
              console.groupEnd();
            } else {
              console.warn(
                '%c[Schedule AI] Warning: 0 checklist events were parsed from model output! Inspect full raw response below.',
                'color: #dc2626; font-weight: bold;'
              );
            }

            console.groupCollapsed('Full Raw LLM Response (click to expand):');
            console.log(generatedMarkdown);
            console.groupEnd();

            console.groupEnd();
          }
        }
      } else if (task.status === 'failed') {
        console.error(`[ILC AI Failed] ${label} for ${task.lessonId}: ${task.error}`);
        saveSuccessMessage = `⚠️ ${label} generation failed`;
        setTimeout(() => {
          saveSuccessMessage = '';
        }, 3500);
      }
    });
  }

  function stopQueueFeedback(): void {
    releaseQueueWatch?.();
    releaseQueueWatch = null;
    unsubscribeQueueFinished?.();
    unsubscribeQueueFinished = null;
  }

  /**
   * True while the active lesson+tab (or course doc) has a queued or processing generation
   * task — drives the PromptCard's Generating... state.
   */
  let isTabGenerating = $derived.by(() => {
    const s = queueStatus.status;
    if (isCourseScope) {
      const matches = (t: { courseId: string; tab: string }) =>
        t.courseId === (courseId || '').toLowerCase() && t.tab === activeTab;
      return Boolean(s.activeTask && matches(s.activeTask)) || s.tasks.some((t) => t.status === 'pending' && matches(t));
    }
    const matches = (t: { courseId: string; lessonId: string; tab: string }) =>
      t.courseId === (courseId || '').toLowerCase() &&
      t.lessonId === selectedLessonId &&
      t.tab === activeTab;
    return Boolean(s.activeTask && matches(s.activeTask)) || s.tasks.some((t) => t.status === 'pending' && matches(t));
  });

  let isScheduleGenerating = $derived.by(() => {
    const s = queueStatus.status;
    const matches = (t: { courseId: string; tab: string }) =>
      t.courseId === (courseId || '').toLowerCase() && t.tab === 'schedule';
    return Boolean(s.activeTask && matches(s.activeTask)) || s.tasks.some((t) => t.status === 'pending' && matches(t));
  });

  let isQueueingMissing: boolean = $state(false);

  async function queueAllMissing() {
    if (!courseId) return;
    const activeModel = await getActiveLlmCard();
    if (!activeModel?.baseUrl) {
      isLLMModalOpen = true;
      return;
    }

    isQueueingMissing = true;
    try {
      const res = await apiFetch('/api/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'enqueue',
          courseId,
          tabs: ['summary', 'cheatsheet', 'test']
        })
      });

      if (res.ok) {
        const data = await res.json();
        const count = data.enqueued?.length || 0;
        if (count > 0) {
          saveSuccessMessage = `✨ Queued ${count} missing item${count === 1 ? '' : 's'} for generation!`;
        } else {
          saveSuccessMessage = `All study items are already generated!`;
        }
        setTimeout(() => {
          saveSuccessMessage = '';
        }, 4000);
      } else {
        const errText = await res.text();
        throw new Error(errText || 'Failed to queue missing items');
      }
    } catch (err: any) {
      alert('Failed to queue missing items: ' + (err?.message || 'Check connection'));
    } finally {
      isQueueingMissing = false;
    }
  }

  let pendingAnnotationQuery: { selectedText: string; query: string } | null = $state(null);

  async function handleAnnotationSubmit(selectedText: string, query: string) {
    const activeModel = await getActiveLlmCard();
    if (!activeModel?.baseUrl) {
      pendingAnnotationQuery = { selectedText, query };
      isLLMModalOpen = true;
      return;
    }

    isGeneratingAI = true;

    try {
      const sessionId = `${courseId}-note`;
      const noteSystemPrompt =
        'You are an expert Ontario secondary school tutor. A student studying course material has highlighted a specific passage and asked a question. Provide a concise, clear, and insightful answer directly addressing the question in the context of the Ontario curriculum and lesson material. Emphasize key terms, legal doctrines, or definitions in bold. Keep the answer focused (1 to 3 short paragraphs or bullet points). Do not repeat the student query or include conversational filler.';

      const lessonContext = tabContents.lesson || tabContents[activeTab] || '';
      const userPrompt = `Course: ${course?.title || courseId}\nLesson: ${currentLessonTitle}\n\nSelected Passage to Explain:\n"${selectedText}"\n\nStudent's Question:\n"${query}"\n\nFull Reference Context:\n${lessonContext}`;

      console.log(`[ILC AI Note Request]`);
      console.log(`- Session ID: ${sessionId}`);
      console.log(`- Selected Excerpt: "${selectedText.slice(0, 100)}..."`);
      console.log(`- User Query: "${query}"`);
      console.log(`- User Prompt Length: ${userPrompt.length} characters`);

      const res = await apiFetch('/api/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generate',
          sessionId,
          systemPrompt: noteSystemPrompt,
          userPrompt
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[ILC AI Note Error] Status: ${res.status}`, errText);
        throw new Error(errText || 'AI Note generation failed');
      }

      const data = await res.json();
      const aiAnswer = data.completion;
      const usageInfo = data.usage?.total_tokens !== undefined ? ` | "total_tokens":${data.usage.total_tokens}` : '';
      console.log(`[ILC AI Note Received] ${aiAnswer.length} characters${usageInfo}`);

      const formattedNote = formatUserNote(query, selectedText, aiAnswer);
      const currentContent = tabContents[activeTab] || '';
      const { updatedMarkdown, success } = insertAnnotationAfterText(
        currentContent,
        selectedText,
        formattedNote
      );

      if (success) {
        tabContents[activeTab] = updatedMarkdown;
        await saveCurrentTab();
        saveSuccessMessage = '✨ AI Note added!';
        setTimeout(() => {
          saveSuccessMessage = '';
        }, 3000);
      } else {
        alert('Could not locate the selected text in the document.');
      }
    } catch (err: any) {
      alert('AI Note Error: ' + (err?.message || 'Check your LLM configuration.'));
    } finally {
      isGeneratingAI = false;
      pendingAnnotationQuery = null;
    }
  }

  function handleDeleteNote(targetText: string, query: string) {
    const current = tabContents[activeTab] || '';
    const { updatedMarkdown, removed } = removeAnnotation(current, targetText || query);
    if (removed) {
      tabContents[activeTab] = updatedMarkdown;
      saveCurrentTab();
      saveSuccessMessage = 'Note removed';
      setTimeout(() => {
        saveSuccessMessage = '';
      }, 2000);
    }
  }

  function handleLLMConfigured() {
    if (pendingAnnotationQuery) {
      const q = pendingAnnotationQuery;
      pendingAnnotationQuery = null;
      handleAnnotationSubmit(q.selectedText, q.query);
    } else if (isCourseScope && activeTab === 'schedule') {
      // Schedule generation always starts from the preferences questionnaire.
      isScheduleModalOpen = true;
    } else if (isCourseScope && activeTab !== 'lesson') {
      generateCourseDocument(activeTab);
    } else {
      triggerAIGeneration();
    }
  }

  function handleCancelEdit() {
    tabContents[activeTab] = originalContents[activeTab];
    isEditing = false;
  }

  async function handleSaveEdit() {
    await saveCurrentTab();
    isEditing = false;
  }

  async function handleExportPDF() {
    if (isExportingPdf || !course) return;

    isExportingPdf = true;
    try {
      if (isCourseScope) {
        if (activeTab === 'lesson') {
          await exportDocumentToPdf({
            courseCode: course.id,
            courseTitle: course.title,
            lessonId: 'Course',
            lessonTitle: 'Complete Course Lessons',
            tab: 'lesson',
            tabDisplayName: 'Complete Lessons',
            rawMarkdown: tabContents.lesson
          });
        } else {
          const displayTitles: Record<string, { lessonTitle: string; tabDisplayName: string }> = {
            summary: { lessonTitle: 'Comprehensive Course Summary', tabDisplayName: 'Course Summary' },
            cheatsheet: { lessonTitle: 'Master Course Cheatsheet', tabDisplayName: 'Course Cheatsheet' },
            test: { lessonTitle: 'Final Course Practice Exam', tabDisplayName: 'Course Practice Test' },
            schedule: { lessonTitle: 'Course Study Schedule', tabDisplayName: 'Course Schedule' }
          };
          const info = displayTitles[activeTab] || { lessonTitle: `Course ${tabDisplayName}`, tabDisplayName: `Course ${tabDisplayName}` };
          await exportDocumentToPdf({
            courseCode: course.id,
            courseTitle: course.title,
            lessonId: 'Course',
            lessonTitle: info.lessonTitle,
            tab: activeTab,
            tabDisplayName: info.tabDisplayName,
            rawMarkdown: tabContents[activeTab]
          });
        }
      } else {
        if (!selectedLessonId) return;
        const exportTabName = activeTab === 'lesson' ? 'Course Notes' : tabDisplayName || activeTab;

        await exportDocumentToPdf({
          courseCode: course.id,
          courseTitle: course.title,
          lessonId: selectedLessonId,
          lessonTitle: currentLessonTitle || selectedLessonId,
          tab: activeTab,
          tabDisplayName: exportTabName,
          rawMarkdown: tabContents[activeTab]
        });
      }
    } catch (err) {
      console.error('Failed to export PDF:', err);
      alert('Failed to generate PDF. Please check the browser console for details.');
    } finally {
      isExportingPdf = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      if (isEditing) {
        handleSaveEdit();
      } else {
        saveCurrentTab();
      }
    } else if (e.key === 'Escape' && isEditing) {
      handleCancelEdit();
    }
  }

  async function handleChaptersUploaded(uploadedCourseId: string) {
    await loadCourse();
    if (selectedLessonId) {
      await loadLesson(selectedLessonId);
    }
    saveSuccessMessage = uploadModalMode === 'replace' ? 'Chapter replaced!' : 'New chapters added!';
    setTimeout(() => {
      saveSuccessMessage = '';
    }, 3000);
  }

  // Full-page document / PDF viewer state
  let activeDocument: { url: string; title: string } | null = $state(null);

  function handleOpenDocument(url: string, title?: string) {
    activeDocument = { url, title: title || url.split('/').pop() || 'Document' };
    if (typeof window !== 'undefined') {
      window.history.pushState({ docViewerOpen: true }, '');
    }
  }

  function handleCloseDocument() {
    activeDocument = null;
    if (typeof window !== 'undefined' && window.history.state?.docViewerOpen) {
      window.history.back();
    }
  }

  function handlePopState() {
    if (activeDocument) {
      activeDocument = null;
    }
  }

  let isRouteSyncing = false;

  function parseTabName(t?: string | null): PageTab | null {
    if (!t) return null;
    const clean = t.toLowerCase().trim();
    if (clean === 'notes') return 'lesson';
    if (['lesson', 'summary', 'cheatsheet', 'test', 'schedule'].includes(clean)) {
      return clean;
    }
    // Custom tabs: any valid slug (created on visit if the lesson lacks it)
    if (isTabSlug(clean)) return clean;
    return null;
  }

  function findLesson(lessons: CourseManifestLesson[], requested: string): CourseManifestLesson | undefined {
    if (!requested) return undefined;
    const clean = requested.toLowerCase().trim();

    // 1. Exact ID match (e.g. "01.02" or "01.06_assign1")
    const exact = lessons.find((l) => l.id.toLowerCase() === clean);
    if (exact) return exact;

    // 2. Normalized zero-padded ID (e.g. "1.2" -> "01.02", "1.02" -> "01.02")
    const normParts = clean.split('.');
    if (normParts.length === 2 && !isNaN(Number(normParts[0])) && !isNaN(Number(normParts[1]))) {
      const padded = `${normParts[0].padStart(2, '0')}.${normParts[1].padStart(2, '0')}`;
      const normMatch = lessons.find((l) => l.id.toLowerCase() === padded);
      if (normMatch) return normMatch;
    }

    // 3. Activity code match (e.g. "u1la2" or "baf3m_u1la2")
    const codeMatch = lessons.find(
      (l) => l.code && (l.code.toLowerCase() === clean || l.code.toLowerCase().endsWith(`_${clean}`))
    );
    if (codeMatch) return codeMatch;

    // 4. Unit ID match (e.g. "01", "1", "unit 1") -> first lesson of that unit
    const unitMatch = clean.match(/^(?:unit\s*)?(\d{1,2})$/);
    if (unitMatch) {
      const uNum = parseInt(unitMatch[1], 10);
      const unitLesson = lessons.find((l) => l.unitNumber === uNum);
      if (unitLesson) return unitLesson;
    }

    // 5. Title match (e.g. "1.2 Types of business organizations")
    const titleMatch = lessons.find((l) => {
      const t = l.title.toLowerCase();
      return t === clean || t.startsWith(clean + ' ') || t.startsWith(clean + ':');
    });
    if (titleMatch) return titleMatch;

    return undefined;
  }

  /** Sentinel thrown inside syncRoute when the route moves on mid-flight. */
  const ROUTE_MOVED_ON = { sentinel: 'route-moved-on' };

  async function syncRoute() {
    if (isRouteSyncing || !courseId) {
      console.log(`[NAV] syncRoute skipped (syncing=${isRouteSyncing}, courseId=${JSON.stringify(courseId)})`);
      return;
    }
    isRouteSyncing = true;

    // This run is authoritative for the route captured below. If the user
    // navigates while we await course/lesson loads, our decisions are stale:
    // acting on them would rewrite the URL back to the OLD route (the
    // "lesson won't switch" bug). Abort instead; the effect re-runs for the
    // new route, and if that run was blocked by the lock we re-run here.
    const syncParams = { lesson: $page.params.lesson, tab: $page.params.tab, search: $page.url.search };
    const routeMovedOn = () =>
      $page.params.lesson !== syncParams.lesson ||
      $page.params.tab !== syncParams.tab ||
      $page.url.search !== syncParams.search;

    console.log(
      `[NAV] syncRoute | params=${syncParams.lesson || '—'}/${syncParams.tab || '—'}${syncParams.search} | selected=${selectedLessonId} tab=${activeTab} scope=${isCourseScope}`
    );

    let aborted = false;
    try {
      if (!course || course.id.toLowerCase() !== courseId.toLowerCase()) {
        await loadCourse(undefined, { skipAutoLesson: true });
        if (routeMovedOn()) throw ROUTE_MOVED_ON;
      }
      if (!course) return;

      const pLesson = $page.params.lesson;
      const pTab = $page.params.tab;
      const qScope = $page.url.searchParams.get('scope');
      const qLesson = $page.url.searchParams.get('lesson');
      const qTab = $page.url.searchParams.get('tab');

      const isTargetCourse =
        pLesson === 'course' ||
        pLesson === 'schedule' ||
        qScope === 'course' ||
        qTab === 'schedule';

      if (isTargetCourse) {
        let targetTab: PageTab = 'lesson';
        if (pLesson === 'schedule' || qTab === 'schedule') {
          targetTab = 'schedule';
        } else {
          const parsed = parseTabName(pTab) || parseTabName(qTab) || 'lesson';
          targetTab = hasCourseDoc(parsed) ? parsed : 'lesson';
        }

        const scopeChanged = !isCourseScope;
        const tabChanged = activeTab !== targetTab;

        isCourseScope = true;
        activeTab = targetTab;

        if (scopeChanged || tabChanged || !tabContents[targetTab]) {
          await loadCourseDocument(targetTab);
          if (routeMovedOn()) throw ROUTE_MOVED_ON;
        }

        const canonical = `/courses/${courseId.toLowerCase()}/course/${targetTab}`;
        if ($page.url.pathname !== canonical || $page.url.search) {
          nav(canonical, { replace: true });
        }
      } else {
        const allLessons = (course.units || []).flatMap((u) => u.lessons);
        const requestedLesson = pLesson || qLesson || '';
        const foundLesson = findLesson(allLessons, requestedLesson);
        const targetLesson = foundLesson ? foundLesson.id : (allLessons[0]?.id || '');
        if (!foundLesson && requestedLesson) {
          console.log(`[NAV] syncRoute: lesson "${requestedLesson}" not found in manifest → falling back to "${targetLesson}"`);
        }

        // A user-initiated switch (selectLesson) loads the lesson first and
        // gotos when it settles — so while that load is in flight the URL
        // still shows OUR (older) params. Loading or rewriting the URL now
        // would fight the user's pick. Stand down; their goto re-triggers us.
        if (isLoadingLesson && selectedLessonId && selectedLessonId !== targetLesson) {
          console.log(
            `[NAV] syncRoute standing down — switch to "${selectedLessonId}" already in flight (params still target "${targetLesson}")`
          );
          return;
        }

        let targetTab: PageTab = parseTabName(pTab) || parseTabName(qTab) || 'lesson';
        if (targetTab === 'schedule') {
          targetTab = 'lesson';
        }

        const scopeChanged = isCourseScope;
        const lessonChanged = selectedLessonId !== targetLesson;
        console.log(
          `[NAV] syncRoute lesson branch | target="${targetLesson}" targetTab=${targetTab} lessonChanged=${lessonChanged} scopeChanged=${scopeChanged}`
        );

        isCourseScope = false;
        activeTab = targetTab;

        if (scopeChanged || lessonChanged || !selectedLessonId) {
          if (targetLesson) {
            await loadLesson(targetLesson);
            if (routeMovedOn()) throw ROUTE_MOVED_ON;
          }
        }

        // A URL naming a custom tab the lesson doesn't have yet (schedule
        // deep link, bookmark) creates the tab file so it can be used.
        if (isCustomTabSlug(targetTab) && lessonBundle && !lessonBundle.tabs[targetTab]) {
          await createCustomTab(targetTab, customTabDisplayName(targetTab));
          if (routeMovedOn()) throw ROUTE_MOVED_ON;
        }

        if (targetLesson) {
          const tabSuffix = targetTab !== 'lesson' ? `/${targetTab}` : '';
          const canonical = `/courses/${courseId.toLowerCase()}/${encodeURIComponent(targetLesson)}${tabSuffix}`;
          if ($page.url.pathname !== canonical || $page.url.search) {
            nav(canonical, { replace: true });
          }
        }
      }
    } catch (e) {
      if (e === ROUTE_MOVED_ON) {
        aborted = true;
        console.log('[NAV] syncRoute aborted — route changed while loading');
      } else {
        throw e;
      }
    } finally {
      isRouteSyncing = false;
    }
    if (aborted) {
      console.log('[NAV] syncRoute re-running for the new route');
      syncRoute();
    }
  }

  $effect(() => {
    const c = courseId;
    const l = $page.params.lesson;
    const t = $page.params.tab;
    const qs = $page.url.search;
    void c;
    void l;
    void t;
    void qs;

    // untrack: syncRoute's preamble reads $state (selectedLessonId, activeTab)
    // — tracking those would re-run this effect (with STALE params) on every
    // state change, spawning the racing syncRoutes that reverted navigation.
    // The effect must fire for route changes only.
    untrack(() => syncRoute());
  });

  onMount(async () => {
    installPerfObservers();
    await loadPrompts();
    startQueueFeedback();
    schedulePdfPrewarm();
    if (typeof window !== 'undefined') {
      window.addEventListener('popstate', handlePopState);
      window.addEventListener('pagehide', flushPendingScroll);
    }
  });

  onDestroy(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('pagehide', flushPendingScroll);
    }
    flushPendingScroll();
    stopQueueFeedback();
  });

  // Current lesson title
  let currentLessonTitle = $derived.by(() => {
    if (!course) return '';
    for (const u of course.units) {
      const found = u.lessons.find((l) => l.id === selectedLessonId);
      if (found) return found.title;
    }
    return '';
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<Header
  courseId={course?.id || courseId}
  courseTitle={course?.title}
  lessonId={isCourseScope ? '' : selectedLessonId}
  lessonTitle={isCourseScope ? 'Complete Course' : currentLessonTitle}
  onLessonUpdated={(lId, tab) => {
    if (tab === 'schedule' || lId === 'schedule') {
      if (isCourseScope && activeTab === 'schedule') {
        loadCourseDocument('schedule');
      }
    } else if (!isCourseScope && lId === selectedLessonId) {
      loadLesson(selectedLessonId);
    }
  }}
/>

{#if isLoadingCourse}
  <div class="flex-1 flex items-center justify-center">
    <Loader2 class="w-6 h-6 animate-spin text-stone-400" />
  </div>
{:else if !course}
  <div class="flex-1 flex flex-col items-center justify-center space-y-3">
    <p class="text-sm text-stone-500">Course not found.</p>
    <button
      type="button"
      onclick={() => nav('/')}
      class="text-xs text-stone-900 font-medium underline cursor-pointer"
    >Return to courses</button>
  </div>
{:else}
  <div class="flex-1 flex flex-col h-[calc(100vh-3.5rem)] overflow-hidden">
    <!-- Sub-Header: Lesson Selector & Tabs -->
    <div class="border-b border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 shrink-0">
      <!-- Left: Lesson Selector & Add Chapters Button -->
      <div class="flex items-center space-x-2">
        <LessonSelector
          {course}
          {selectedLessonId}
          {activeTab}
          isCourseMode={isCourseScope}
          onSelectLesson={(id) => selectLesson(id)}
          onSelectCourseMode={() => selectCourseMode()}
        />

        {#if !isCourseScope}
          <div class="flex items-center space-x-1.5 shrink-0">
            <button
              onclick={() => { uploadModalMode = 'add'; isUploadModalOpen = true; }}
              class="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-800 hover:bg-stone-50 dark:hover:bg-stone-700 text-xs font-medium text-stone-700 dark:text-stone-300 transition shadow-2xs cursor-pointer"
              title="Add new chapters / lessons to this course"
            >
              <Plus class="w-3.5 h-3.5 text-stone-500 dark:text-stone-400" />
              <span>Add</span>
            </button>

            <button
              onclick={() => { uploadModalMode = 'replace'; isUploadModalOpen = true; }}
              class="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-800 hover:bg-stone-50 dark:hover:bg-stone-700 text-xs font-medium text-stone-700 dark:text-stone-300 transition shadow-2xs cursor-pointer"
              title="Replace current chapter ({currentLessonTitle || selectedLessonId}) with a new file upload"
            >
              <RefreshCw class="w-3.5 h-3.5 text-stone-500 dark:text-stone-400" />
              <span>Replace</span>
            </button>

            <button
              onclick={queueAllMissing}
              disabled={isQueueingMissing}
              class="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/40 hover:bg-amber-100 dark:hover:bg-amber-900/50 text-xs font-medium text-amber-900 dark:text-amber-200 transition shadow-2xs cursor-pointer disabled:opacity-50"
              title="Scan course and queue all ungenerated study sheets (Summary, Cheatsheet, Test) in background"
            >
              {#if isQueueingMissing}
                <Loader2 class="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 animate-spin" />
                <span>Queueing...</span>
              {:else}
                <Sparkles class="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                <span>Generate Missing</span>
              {/if}
            </button>
          </div>
        {/if}
      </div>

      <!-- Middle: Study Tabs (Notes | Summary | Cheatsheet | Test) -->
      <div class="inline-flex rounded-lg border border-stone-200 dark:border-stone-800 p-0.5 bg-stone-100 dark:bg-stone-800/70 text-xs font-medium">
        <button
          onclick={() => switchTab('lesson')}
          class="flex items-center space-x-1.5 px-3 py-1 rounded-md transition {activeTab === 'lesson' ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-2xs font-semibold' : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200'}"
        >
          <BookOpen class="w-3.5 h-3.5" />
          <span>Lessons</span>
        </button>

        <button
          onclick={() => switchTab('summary')}
          class="flex items-center space-x-1.5 px-3 py-1 rounded-md transition {activeTab === 'summary' ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-2xs font-semibold' : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200'}"
        >
          <Sparkles class="w-3.5 h-3.5" />
          <span>Summary</span>
        </button>

        <button
          onclick={() => switchTab('cheatsheet')}
          class="flex items-center space-x-1.5 px-3 py-1 rounded-md transition {activeTab === 'cheatsheet' ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-2xs font-semibold' : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200'}"
        >
          <ListCollapse class="w-3.5 h-3.5" />
          <span>Cheatsheet</span>
        </button>

        <button
          onclick={() => switchTab('test')}
          class="flex items-center space-x-1.5 px-3 py-1 rounded-md transition {activeTab === 'test' ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-2xs font-semibold' : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200'}"
        >
          <CheckCircle2 class="w-3.5 h-3.5" />
          <span>Practice Test</span>
        </button>

        {#if !isCourseScope}
          {#each customTabs as slug (slug)}
            <div class="relative group/tab">
              <button
                onclick={() => switchTab(slug)}
                class="flex items-center px-3 py-1 rounded-md transition {activeTab === slug ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-2xs font-semibold' : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200'}"
                title="Custom tab — {selectedLessonId}.{slug}.md"
              >
                <span>{customTabDisplayName(slug)}</span>
              </button>
              <button
                onclick={() => handleDeleteCustomTab(slug)}
                class="absolute -top-1 -right-1 hidden group-hover/tab:flex items-center justify-center w-3.5 h-3.5 rounded-full bg-stone-300 dark:bg-stone-600 text-stone-700 dark:text-stone-200 hover:bg-red-400 dark:hover:bg-red-500 hover:text-white transition cursor-pointer"
                title="Delete {customTabDisplayName(slug)} tab for this lesson"
              >
                <X class="w-2 h-2" />
              </button>
            </div>
          {/each}

          <button
            onclick={openNewTabModal}
            class="flex items-center justify-center w-7 py-1 rounded-md text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200 hover:bg-stone-200/60 dark:hover:bg-stone-700/60 transition cursor-pointer"
            title="Create a new tab for this lesson (e.g. Assignment)"
          >
            <Plus class="w-3.5 h-3.5" />
          </button>
        {/if}

        {#if isCourseScope}
          <button
            onclick={() => switchTab('schedule')}
            class="flex items-center space-x-1.5 px-3 py-1 rounded-md transition {activeTab === 'schedule' ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-2xs font-semibold' : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200'}"
          >
            <CalendarDays class="w-3.5 h-3.5" />
            <span>Schedule</span>
          </button>

          {#each courseCustomTabs as slug (slug)}
            <div class="relative group/tab">
              <button
                onclick={() => switchTab(slug)}
                class="flex items-center px-3 py-1 rounded-md transition {activeTab === slug ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-2xs font-semibold' : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200'}"
                title="Custom course tab — course.{slug}.md"
              >
                <span>{customTabDisplayName(slug)}</span>
              </button>
            </div>
          {/each}
        {/if}
      </div>
    </div>

    <!-- Main Workspace Content Area (the scroll container for scroll memory).
         overflow-anchor: none — restoring an offset must land exactly there;
         without it, Chromium's scroll anchoring re-adjusts the position when
         late-laying-out images change the article height, landing a few
         dozen pixels short (and the drifted value gets re-saved). -->
    <div
      class="flex-1 overflow-y-auto p-4 sm:p-8 max-w-5xl mx-auto w-full [overflow-anchor:none]"
      bind:this={contentScroller}
      onscroll={handleContentScroll}
    >
      {#if isCourseScope ? isLoadingCourseDoc : isLoadingLesson}
        <div class="h-64 flex items-center justify-center">
          <Loader2 class="w-6 h-6 animate-spin text-stone-300" />
        </div>
      {:else}
        <!-- Prompt Card for generated tabs (when not editing raw markdown) -->
        {#if activeTab !== 'lesson' && !isEditing}
          <PromptCard
            prompt={parsedActiveTab.frontmatter.prompt || defaultPromptForActiveTab}
            defaultPrompt={defaultPromptForActiveTab}
            tabName={isCourseScope ? `Course ${tabDisplayName}` : tabDisplayName}
            isGenerating={isCourseScope ? (activeTab === 'schedule' ? isScheduleGenerating : isGeneratingCourseDoc) : isTabGenerating}
            onChangePrompt={handlePromptChange}
            onRegenerate={isCourseScope
            ? activeTab === 'schedule'
              ? // Schedule regeneration always starts from the (adjustable) survey.
                () => (isScheduleModalOpen = true)
              : () => generateCourseDocument(activeTab)
            : triggerAIGeneration}
            onResetPrompt={() => handlePromptChange(defaultPromptForActiveTab)}
          />
        {/if}

        <!-- Top-Right Action Controls (Sticky): direct child of the scroll
             container. Negative top offsets cancel the container's py padding
             (p-4 = 16px, sm:p-8 = 32px) so the row pins ~2px below the
             header line instead of 16-32px down. -->
        <div class="sticky -top-[14px] sm:-top-[30px] z-30 flex justify-end px-8 sm:px-12 pt-0.5 mt-1 -mb-[30px] pointer-events-none">
          <div class="pointer-events-auto flex items-center space-x-2">
            {#if isEditing}
              <button
                onclick={handleCancelEdit}
                class="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border border-stone-200/90 dark:border-stone-700 bg-white/95 dark:bg-stone-900/95 backdrop-blur-sm hover:bg-white dark:hover:bg-stone-800 text-xs font-medium text-stone-700 dark:text-stone-300 transition shadow-xs hover:shadow-sm cursor-pointer"
                title="Discard changes and exit edit mode (Esc)"
              >
                <X class="w-3.5 h-3.5 text-stone-500 dark:text-stone-400" />
                <span>Cancel</span>
              </button>

              <button
                onclick={handleSaveEdit}
                disabled={isSaving}
                class="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg bg-stone-900/95 dark:bg-stone-100 dark:text-stone-950 backdrop-blur-sm hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-50 text-white text-xs font-medium transition shadow-xs hover:shadow-sm cursor-pointer"
                title="Save changes to file (⌘+S)"
              >
                {#if isSaving}
                  <Loader2 class="w-3.5 h-3.5 animate-spin" />
                  <span>Saving...</span>
                {:else if saveSuccessMessage}
                  <Check class="w-3.5 h-3.5 text-emerald-400 dark:text-emerald-600" />
                  <span class="text-emerald-400 dark:text-emerald-600 font-semibold">{saveSuccessMessage}</span>
                {:else}
                  <Save class="w-3.5 h-3.5" />
                  <span>Save</span>
                {/if}
              </button>
            {:else}
              <button
                onclick={handleExportPDF}
                disabled={isExportingPdf}
                class="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border border-stone-200/90 dark:border-stone-700 bg-white/95 dark:bg-stone-900/95 backdrop-blur-sm hover:bg-white dark:hover:bg-stone-800 text-xs font-medium text-stone-700 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 shadow-xs hover:shadow-sm transition cursor-pointer disabled:opacity-50"
                title="Generate and download PDF for this document"
              >
                {#if isExportingPdf}
                  <Loader2 class="w-3.5 h-3.5 animate-spin text-stone-500 dark:text-stone-400" />
                  <span>PDF...</span>
                {:else}
                  <FileDown class="w-3.5 h-3.5 text-stone-500 dark:text-stone-400" />
                  <span>PDF</span>
                {/if}
              </button>

              {#if !(isCourseScope && activeTab === 'lesson')}
                <button
                  onclick={() => (isEditing = true)}
                  class="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border border-stone-200/90 dark:border-stone-700 bg-white/95 dark:bg-stone-900/95 backdrop-blur-sm hover:bg-white dark:hover:bg-stone-800 text-xs font-medium text-stone-700 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 shadow-xs hover:shadow-sm transition cursor-pointer"
                  title="Edit content"
                >
                  <Edit3 class="w-3.5 h-3.5 text-stone-500 dark:text-stone-400" />
                  <span>Edit</span>
                </button>
              {/if}
            {/if}
          </div>
        </div>

        <!-- Main Card -->
        <div class="relative bg-white dark:bg-stone-900 rounded-2xl border border-stone-200 dark:border-stone-800 shadow-2xs group">
          {#if isCourseScope && isGeneratingCourseDoc && activeTab !== 'schedule'}
            <div class="h-64 flex flex-col items-center justify-center space-y-3 p-8 text-center">
              <Loader2 class="w-7 h-7 animate-spin text-amber-500" />
              <div class="text-sm font-medium text-stone-800 dark:text-stone-200">
                Generating Course {tabDisplayName}...
              </div>
              <p class="text-xs text-stone-500 dark:text-stone-400 max-w-sm">
                Synthesizing lesson {activeTab}s across all units with AI. This may take 15–30 seconds.
              </p>
            </div>
          {:else if isEditing}
            <!-- CodeMirror Editor (direct raw markdown with YAML frontmatter) -->
            <div class="p-4 sm:p-6 pt-16">
              <div class="h-[calc(100vh-16rem)]">
                <CodeMirrorEditor
                  value={tabContents[activeTab]}
                  courseId={course.id}
                  onChange={handleEditorChange}
                  onSave={handleSaveEdit}
                />
              </div>
            </div>
          {:else if activeTab === 'test'}
            <!-- Practice Test Interactive Runner -->
            <div class="p-6 sm:p-10">
              {#key `${quizRunnerKey}-${parsedActiveTab.body}`}
                <QuizRunner
                  testMarkdown={parsedActiveTab.body}
                />
              {/key}
            </div>
          {:else if activeTab === 'schedule' && isCourseScope}
            <!-- Schedule: structured viewer or first-time intro -->
            <div class="p-6 sm:p-10">
              {#if isScheduleGenerating}
                <div class="mb-5 p-3.5 rounded-xl border border-blue-200 dark:border-blue-800/60 bg-blue-50/70 dark:bg-blue-950/40 flex items-center space-x-3 text-blue-900 dark:text-blue-200">
                  <Loader2 class="w-4 h-4 animate-spin text-blue-600 dark:text-blue-400 shrink-0" />
                  <div class="text-xs">
                    <span class="font-semibold">Schedule is generating in the background...</span>
                    <span class="text-blue-700 dark:text-blue-300 ml-1">You can continue browsing. The new schedule will appear here automatically when complete. Watch the AI Queue in the header for real-time progress.</span>
                  </div>
                </div>
              {/if}

              {#if tabContents.schedule.trim().length > 0}
                {#if scheduleWarnings.length > 0 && !scheduleWarningsDismissed}
                  <div class="mb-5 p-3.5 rounded-xl border border-amber-200 dark:border-amber-800/60 bg-amber-50/70 dark:bg-amber-950/40">
                    <div class="flex items-start justify-between gap-3">
                      <div class="space-y-1.5">
                        <div class="flex items-center space-x-2 text-amber-900 dark:text-amber-200">
                          <AlertTriangle class="w-4 h-4 shrink-0" />
                          <span class="text-xs font-semibold">Schedule check — {scheduleWarnings.length} {scheduleWarnings.length === 1 ? 'issue' : 'issues'} found</span>
                        </div>
                        <ul class="text-xs text-amber-800 dark:text-amber-300 leading-relaxed list-disc list-inside space-y-0.5">
                          {#each scheduleWarnings as warning}
                            <li>{warning}</li>
                          {/each}
                        </ul>
                        <p class="text-[11px] text-amber-700/80 dark:text-amber-400/80">
                          The schedule was saved anyway — consider "Rebuild with new preferences" or editing the markdown.
                        </p>
                      </div>
                      <button
                        onclick={() => (scheduleWarningsDismissed = true)}
                        class="p-1 rounded-md text-amber-500 hover:text-amber-800 dark:hover:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition cursor-pointer shrink-0"
                        title="Dismiss"
                      >
                        <X class="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                {/if}
                <ScheduleViewer
                  courseId={course.id}
                  markdown={tabContents.schedule}
                  onToggle={handleScheduleToggle}
                  onRebuild={handleScheduleRebuild}
                  onEditMarkdown={() => (isEditing = true)}
                  isGenerating={isScheduleGenerating}
                />
              {:else}
                <div class="max-w-lg mx-auto py-14 text-center space-y-4">
                  <div class="mx-auto w-fit p-3 rounded-2xl bg-stone-900 dark:bg-stone-800 text-white dark:text-stone-200 shadow-2xs">
                    {#if isScheduleGenerating}
                      <Loader2 class="w-6 h-6 animate-spin text-amber-500" />
                    {:else}
                      <CalendarDays class="w-6 h-6" />
                    {/if}
                  </div>
                  <div class="space-y-1.5">
                    <h3 class="text-base font-semibold text-stone-900 dark:text-stone-100">
                      {isScheduleGenerating ? 'Generating study schedule...' : 'Build a study schedule'}
                    </h3>
                    <p class="text-xs text-stone-500 dark:text-stone-400 leading-relaxed">
                      {isScheduleGenerating
                        ? 'Your personalized study schedule is being generated in the background AI queue. Watch the header for progress.'
                        : 'Answer a few questions about your available days and time, and the planner will lay out every lesson, review session, and assignment deadline across real dates.'}
                    </p>
                  </div>
                  {#if !isScheduleGenerating}
                    <button
                      onclick={() => (isScheduleModalOpen = true)}
                      class="px-4 py-2 rounded-lg bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-xs font-medium hover:bg-stone-800 dark:hover:bg-stone-200 transition shadow-sm cursor-pointer"
                    >
                      Build Schedule
                    </button>
                  {/if}
                </div>
              {/if}
            </div>
          {:else}
            <!-- Markdown Reader View -->
            <article class="p-6 sm:p-10">
              <MarkdownViewer
                markdown={parsedActiveTab.body}
                courseId={course.id}
                onDeleteNote={handleDeleteNote}
                onOpenDocument={handleOpenDocument}
              />
            </article>
          {/if}
        </div>
      {/if}
    </div>
  </div>

  <!-- Scroll-to-top: appears once the reader is a screen or so down -->
  {#if showScrollTop}
    <button
      type="button"
      onclick={scrollWorkspaceToTop}
      class="fixed bottom-5 right-5 z-30 flex items-center justify-center w-10 h-10 rounded-full border border-stone-200/90 dark:border-stone-700 bg-white/95 dark:bg-stone-900/95 backdrop-blur-sm text-stone-500 dark:text-stone-400 shadow-md hover:bg-white dark:hover:bg-stone-800 hover:text-stone-900 dark:hover:text-stone-100 transition cursor-pointer"
      title="Scroll to top"
      aria-label="Scroll to top"
    >
      <ArrowUp class="w-4 h-4" />
    </button>
  {/if}

  {#if !isEditing && !isCourseScope}
    <SelectionToolbar
      containerSelector=".markdown-body"
      isGenerating={isGeneratingAI}
      onSubmitQuery={handleAnnotationSubmit}
    />
  {/if}

  {#if activeDocument}
    <DocumentViewerModal
      url={activeDocument.url}
      title={activeDocument.title}
      courseTitle={course.title}
      onClose={handleCloseDocument}
    />
  {/if}

  <UploadModal
    isOpen={isUploadModalOpen}
    presetCourseId={course.id}
    mode={uploadModalMode}
    targetLessonId={selectedLessonId}
    targetLessonTitle={currentLessonTitle}
    onClose={() => (isUploadModalOpen = false)}
    onUploaded={handleChaptersUploaded}
  />

  <ConfigureLLMModal
    isOpen={isLLMModalOpen}
    onClose={() => (isLLMModalOpen = false)}
    onConfigured={handleLLMConfigured}
  />

  <SchedulePreferencesModal
    isOpen={isScheduleModalOpen}
    onClose={() => (isScheduleModalOpen = false)}
    onGenerate={handleScheduleGenerate}
    promptTemplate={genericPrompts['course_schedule_enrichment'] || genericPrompts['course_schedule'] || ''}
    courseTitle={course.title}
  />

  <!-- New custom tab modal -->
  {#if isNewTabModalOpen}
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/40 dark:bg-black/60 backdrop-blur-xs animate-in fade-in duration-150">
      <div class="bg-white dark:bg-stone-900 rounded-xl border border-stone-200 dark:border-stone-800 shadow-xl max-w-sm w-full p-5 space-y-4">
        <div class="space-y-1">
          <div class="flex items-center space-x-2">
            <div class="p-1 rounded-md bg-stone-900 dark:bg-stone-800 text-white dark:text-stone-200">
              <Plus class="w-3.5 h-3.5" />
            </div>
            <h3 class="text-sm font-semibold text-stone-900 dark:text-stone-100">
              New tab for lesson {selectedLessonId}
            </h3>
          </div>
          <p class="text-xs text-stone-500 dark:text-stone-400 leading-relaxed">
            A custom tab just for this lesson, saved as markdown with its own prompt.
          </p>
        </div>

        <div class="space-y-1.5">
          <label for="new-tab-name" class="text-[11px] font-semibold text-stone-500 dark:text-stone-400 uppercase tracking-wider">
            Tab name
          </label>
          <input
            id="new-tab-name"
            type="text"
            bind:value={newTabName}
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleCreateTabFromModal();
              } else if (e.key === 'Escape') {
                isNewTabModalOpen = false;
              }
            }}
            placeholder="e.g. Assignment"
            class="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-950 text-xs text-stone-800 dark:text-stone-100 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100 transition"
          />
          <p class="text-[11px] text-stone-400 dark:text-stone-500 font-mono">
            {selectedLessonId}.{slugifyTabName(newTabName) || '…'}.md
          </p>
          {#if newTabError}
            <p class="text-[11px] text-red-600 dark:text-red-400">{newTabError}</p>
          {/if}
        </div>

        <div class="flex justify-end items-center space-x-2 pt-2 border-t border-stone-100 dark:border-stone-800">
          <button
            onclick={() => (isNewTabModalOpen = false)}
            class="px-3 py-1.5 rounded-lg text-xs font-medium text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
          >
            Cancel
          </button>
          <button
            onclick={handleCreateTabFromModal}
            disabled={isCreatingTab || !newTabName.trim()}
            class="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg bg-stone-900 dark:bg-stone-100 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-50 text-white dark:text-stone-900 text-xs font-medium transition cursor-pointer"
          >
            {#if isCreatingTab}
              <Loader2 class="w-3.5 h-3.5 animate-spin" />
              <span>Creating...</span>
            {:else}
              <Plus class="w-3.5 h-3.5" />
              <span>Create</span>
            {/if}
          </button>
        </div>
      </div>
    </div>
  {/if}
{/if}

<script lang="ts">
  import { apiFetch, getApiBaseUrl } from '$lib/api';
  import { confirmDialog } from '$lib/dialog';
  import { getActiveLlmCard } from '$lib/llmClient';
  import { queueStatus } from '$lib/queueStatus.svelte';
  import { page } from '$app/stores';
  import { goto, replaceState, pushState } from '$app/navigation';
  import Header from '$lib/components/Header.svelte';
  import LessonSelector from '$lib/components/LessonSelector.svelte';
  import MarkdownViewer from '$lib/components/MarkdownViewer.svelte';
  import HtmlViewer from '$lib/components/HtmlViewer.svelte';
  import { getLessonViewMode, setLessonViewMode } from '$lib/preferences';
  import CodeMirrorEditor from '$lib/components/CodeMirrorEditor.svelte';
  import QuizRunner from '$lib/components/QuizRunner.svelte';
  import UploadModal from '$lib/components/UploadModal.svelte';
  import PromptCard from '$lib/components/PromptCard.svelte';
  import ConfigureLLMModal from '$lib/components/ConfigureLLMModal.svelte';
  import SchedulePreferencesModal from '$lib/components/SchedulePreferencesModal.svelte';
  import type { SchedulePreferences } from '$lib/schedule';
  import ScheduleViewer from '$lib/components/ScheduleViewer.svelte';
  import SyncScheduleModal from '$lib/components/SyncScheduleModal.svelte';
  import DocumentViewerModal from '$lib/components/DocumentViewerModal.svelte';
  import PDFViewer from '$lib/components/pdf/PDFViewer.svelte';
  import { pdfCloseDocument, prewarmCourseBook, recordCourseBookOpened } from '$lib/pdfClient';
  import MarkupMenu from '$lib/components/MarkupMenu.svelte';
  import StickyNotePlus from '$lib/components/icons/StickyNotePlus.svelte';
  import { extendMarkdownContent } from '$lib/markup/extendPage';
  import {
    exitMarkupMode,
    markupUi,
    redo as markupRedo,
    undo as markupUndo
  } from '$lib/markup/annotationStore.svelte';
  import { parseFrontmatter, serializeWithFrontmatter } from '$lib/parser/frontmatter';
  import { stripLessonMedia } from '$lib/markdown/stripMedia';
  import { validateScheduleMarkdown } from '$lib/parser/scheduleValidation';
  import { ScheduleParser } from '$lib/parser/scheduleParser';
  import { removeAnnotation } from '$lib/parser/annotationInserter';
  import type { CourseManifest, CourseManifestLesson } from '$lib/parser/courseIngest';
  import type { LessonContentBundle } from '$lib/server/courses';
  import {
    isCustomTabSlug,
    isTabSlug,
    isCourseTab,
    isUnitTab,
    isUnitScopeId,
    parseUnitNumber,
    formatUnitScopeId,
    UNIT_TABS,
    customTabDisplayName,
    validateTabName,
    slugifyTabName,
    starterPromptForTab,
    docFileName,
    parseDocFileName
  } from '$lib/tabs';
  import { onMount, onDestroy, untrack, tick } from 'svelte';
  import {
    ArrowUp,
    ArrowRight,
    Bookmark,
    Book,
    BookOpen,
    FileText,
    UserPen,
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
    RotateCcw,
    CalendarSync,
    FileDown,
    MoreHorizontal,
    MoreVertical,
    ChevronRight,
    ChevronDown,
    ScrollText,
    ThumbsUp
  } from 'lucide-svelte';
  import { exportDocumentToPdf } from '$lib/pdf/exportPdf';
  import { schedulePdfPrewarm } from '$lib/pdf/pdfClient';
  import { afterPaint, installPerfObservers, perf } from '$lib/perf';
  import type { Checkpoint, Anchor } from '$lib/checkpoint';
  import { resolveMarkdownAnchorPixel } from '$lib/checkpoint';
  import { buildCheckpointAskUserPrompt, DEFAULT_CHECKPOINT_ASK_PROMPT } from '$lib/checkpoint/askPrompt';
  import FloatingCheckpointTrigger from '$lib/components/FloatingCheckpointTrigger.svelte';
  import CheckpointMarker from '$lib/components/CheckpointMarker.svelte';
  import AskAiComposer from '$lib/components/AskAiComposer.svelte';
  import CheckpointModal from '$lib/components/CheckpointModal.svelte';
  import { getResumeLastPosition, resolveLastAccessedCourseRoute, setCourseLastLocation } from '$lib/preferences';

  let courseId = $derived($page.params.course_id);
  let course: CourseManifest | null = $state(null);
  let selectedLessonId: string = $state('');
  // Tab slugs: built-ins (lesson/summary/notes/test), course-scope
  // schedule, and per-lesson custom tabs discovered from tab files on disk.
  type PageTab = string;
  let activeTab: PageTab = $state('lesson');
  let isEditing: boolean = $state(false);
  let lessonViewMode: 'original' | 'markdown' = $state('original');
  let isUploadModalOpen: boolean = $state(false);
  let uploadModalMode: 'add' | 'replace' = $state('add');
  let isLessonActionsOpen: boolean = $state(false);
  let isActionMenuOpen: boolean = $state(false);
  let isLLMModalOpen: boolean = $state(false);
  let isScheduleModalOpen: boolean = $state(false);
  let isSyncModalOpen: boolean = $state(false);

  // Complete course scope states
  let isCourseScope: boolean = $state(false);
  let isLoadingCourseDoc: boolean = $state(false);
  let isGeneratingCourseDoc: boolean = $state(false);
  let quizRunnerKey: number = $state(0);
  let isMobileTabDropdownOpen: boolean = $state(false);

  // Persistent PDF Book state: keeps PDFium mounted while switching tabs within the course,
  // but destroys and frees native memory when navigating to a different course.
  let hasLoadedBookOnce: boolean = $state(false);
  let lastLoadedBookCourseId: string | null = $state(null);

  const queryTargetPdfPage = $derived.by(() => {
    const p = $page.url.searchParams.get('page');
    const n = p ? parseInt(p, 10) : null;
    return n && !Number.isNaN(n) && n > 0 ? n : null;
  });

  $effect(() => {
    if (activeTab === 'book' && course?.id) {
      hasLoadedBookOnce = true;
      lastLoadedBookCourseId = course.id;
      recordCourseBookOpened(course.id);
    }
  });

  $effect(() => {
    const currentCId = courseId;
    if (currentCId) {
      prewarmCourseBook(currentCId);
    }
    if (lastLoadedBookCourseId && currentCId && lastLoadedBookCourseId.toLowerCase() !== currentCId.toLowerCase()) {
      // Unmount viewer to free webview blobs, but let the Rust MAX_OPEN_DOCUMENTS=4 LRU
      // maintain the document handle so A -> B -> A course round trips remain instant!
      hasLoadedBookOnce = false;
      lastLoadedBookCourseId = null;
    }
  });

  let activeTabLabel = $derived.by(() => {
    if (activeTab === 'book') return 'Book';
    if (isCourseScope) {
      if (activeTab === 'logs') return 'Logs';
      return 'Practice Test';
    } else if (isUnitScope) {
      if (activeTab === 'assignments') return 'Assignments';
      if (activeTab === 'test') return 'Unit Test';
    } else {
      if (activeTab === 'lesson') return 'Lessons';
      if (activeTab === 'summary') return 'Summary';
      if (activeTab === 'notes' || activeTab === 'studysheet') return 'MyWork';
    }
    return customTabDisplayName(activeTab);
  });

  // Unit scope states
  let isUnitScope: boolean = $derived(
    !isCourseScope && isUnitScopeId(selectedLessonId)
  );

  let currentUnitNumber = $derived(
    parseUnitNumber(selectedLessonId)
  );

  let currentUnit = $derived.by(() => {
    const c = course;
    if (currentUnitNumber === null || !c || !Array.isArray(c.units)) return null;
    return c.units.find((u) => u.number === currentUnitNumber) || null;
  });

  let allCourseLessons: CourseManifestLesson[] = $derived.by(() => {
    const currentCourse = course;
    if (!currentCourse || !Array.isArray(currentCourse.units)) return [];
    return currentCourse.units.flatMap((u) => u.lessons || []);
  });

  let bookmarkedLessons = $derived.by(() => {
    return allCourseLessons
      .filter((l) => Boolean(l.pageRange && l.pageRange.trim()))
      .map((l) => ({
        id: l.id,
        title: l.title,
        pageRange: l.pageRange!.trim(),
        readingDescription: l.readingDescription?.trim()
      }));
  });

  let currentLessonIndex = $derived(
    allCourseLessons.findIndex((l) => l.id.toLowerCase() === (selectedLessonId || '').toLowerCase())
  );

  let currentLessonItem: CourseManifestLesson | null = $derived(
    currentLessonIndex !== -1 ? allCourseLessons[currentLessonIndex] : null
  );

  let nextLessonItem: CourseManifestLesson | null = $derived(
    currentLessonIndex !== -1 && currentLessonIndex < allCourseLessons.length - 1
      ? allCourseLessons[currentLessonIndex + 1]
      : null
  );

  function goToNextLesson() {
    if (nextLessonItem) {
      isLessonActionsOpen = false;
      selectLesson(nextLessonItem.id);
    }
  }

  async function startPopQuiz() {
    if (!courseId || !selectedLessonId) return;

    const confirmed = await confirmDialog(
      'Have you read the lesson fully? Are you ready to do the completion test?',
      'Pop Quiz Readiness Check'
    );
    if (!confirmed) return;

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    goto(`/courses/${courseId.toLowerCase()}/${encodeURIComponent(selectedLessonId)}/popquiz/${timestamp}`);
  }

  // Lesson bundle and generic prompt templates
  let lessonBundle: LessonContentBundle | null = $state(null);
  let genericPrompts: Record<string, string> = $state({});

  /**
   * Effective format for the current lesson — resolved from the loaded bundle when
   * available, otherwise falling back to the manifest entry so the view-mode toggle
   * and reader branch are correct even before the async fetch completes.
   */
  let effectiveFormat = $derived.by((): 'markdown' | 'html' | 'pdf' | 'video' => {
    const fmt = (lessonBundle as LessonContentBundle | null)?.format ?? currentLessonItem?.format;
    if (fmt === 'html' || fmt === 'pdf' || fmt === 'video') return fmt;
    return 'markdown';
  });

  // Custom tabs discovered from this lesson's tab files on disk (excluding summary, which has dedicated position)
  let customTabs = $derived.by(() => {
    if (!lessonBundle?.tabs) return [];
    return Object.keys(lessonBundle.tabs)
      .filter((slug) => isCustomTabSlug(slug) && slug !== 'summary')
      .sort();
  });

  let hasSummaryTab = $derived.by(() => {
    return Boolean(lessonBundle?.tabs && 'summary' in lessonBundle.tabs);
  });

  // Custom tabs are lesson-only; overall course scope only has built-in course tabs or course book.
  function hasCourseDoc(tab: string): boolean {
    return isCourseTab(tab) || (tab === 'book' && Boolean(course?.coursePDF));
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
    notes: '',
    studysheet: '',
    test: '',
    schedule: '',
    logs: ''
  });

  let originalContents: Record<string, string> = $state({
    lesson: '',
    summary: '',
    notes: '',
    studysheet: '',
    test: '',
    schedule: '',
    logs: ''
  });

  let courseScheduleMarkdown: string = $state('');

  let isCurrentLessonDoneInSchedule = $derived.by(() => {
    if (!selectedLessonId) return false;
    const schedule = courseScheduleMarkdown || tabContents.schedule;
    if (!schedule || !schedule.trim()) return false;

    try {
      const parsed = ScheduleParser.parseMarkdown(schedule);
      const targetNormalized = selectedLessonId.toLowerCase();
      const targetWithoutZero = targetNormalized.replace(/^0/, '');

      const matchingEvents = parsed.events.filter((e) => {
        const evLesson = (e.lessonId || '').toLowerCase();
        const evWithoutZero = evLesson.replace(/^0/, '');
        return evLesson === targetNormalized || evWithoutZero === targetWithoutZero;
      });

      if (matchingEvents.length === 0) return false;
      return matchingEvents.some((e) => e.done);
    } catch {
      return false;
    }
  });

  async function loadCourseSchedule() {
    if (!courseId) return;
    try {
      const res = await apiFetch(`/api/courses/${courseId}/course-docs?type=schedule`);
      if (res.ok) {
        const data = await res.json();
        if (data.exists && typeof data.markdown === 'string') {
          courseScheduleMarkdown = data.markdown;
          tabContents.schedule = data.markdown;
          originalContents.schedule = data.markdown;
        }
      }
    } catch {}
  }

  let isLoadingCourse = $state(true);
  let isLoadingLesson = $state(false);
  let isSaving = $state(false);
  let saveSuccessMessage = $state('');
  let isExportingPdf = $state(false);
  let showPromptCard = $state(false);

  function togglePromptCard() {
    showPromptCard = !showPromptCard;
    if (showPromptCard && contentScroller) {
      contentScroller.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  // ---- Workspace checkpoints (position and notes) -----------------------
  let contentScroller = $state<HTMLDivElement | undefined>();
  let showScrollTop = $state(false);
  const SCROLL_TOP_BUTTON_AFTER = 400;
  const SCROLL_SAVE_DEBOUNCE_MS = 300;
  let scrollSaveTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingScroll: { file: string; top: number } | null = null;

  let checkpoints: Checkpoint[] = $state([]);
  let hasLoadedCheckpoints = $state(false);
  let isCheckpointModalOpen: boolean = $state(false);
  let activeCheckpoint: Partial<Checkpoint> | null = $state(null);
  let openNoteIds = $state<Set<string>>(new Set());

  let lastRestoredFile: string = '';
  let lastHandledCheckpointQuery: string = '';

  let currentFile = $derived(
    docFileName(isCourseScope ? 'course' : selectedLessonId, activeTab, isCourseScope)
  );
  let currentFileNotes = $derived(
    checkpoints.filter(
      (c) => (c.type === 'note' || c.type === 'highlight' || c.type === 'ai') && c.file === currentFile
    )
  );

  let activeSelection = $state<{
    text: string;
    anchor?: Anchor;
    selection?: import('$lib/checkpoint').SelectionRange;
    verticalPosition: number;
  } | null>(null);

  let externalCursorPosition = $state<{ cursorY: number; scrollTop: number } | null>(null);
  let htmlAnchorPositions = $state<Record<string, number>>({});

  // Selections and anchor lookups belong to one document. Clear them whenever
  // the rendered document changes so nothing carries over to another
  // tab/lesson/rendering mode.
  let lastSelectionScope = '';
  $effect(() => {
    const scope = `${courseId}|${currentFile}|${lessonViewMode}`;
    if (scope === lastSelectionScope) return;
    lastSelectionScope = scope;
    activeSelection = null;
    externalCursorPosition = null;
    htmlAnchorPositions = {};
    openNoteIds = new Set();
  });

  async function loadCheckpoints() {
    if (!courseId) return;
    try {
      const res = await apiFetch(`/api/courses/${courseId}/checkpoints`);
      if (res.ok) {
        const data = await res.json();
        checkpoints = data.checkpoints || [];
        hasLoadedCheckpoints = true;
      }
    } catch (e) {
      console.warn('Failed to load checkpoints:', e);
    }
  }

  function handleContentScroll() {
    if (!contentScroller) return;
    const top = contentScroller.scrollTop;
    showScrollTop = top > SCROLL_TOP_BUTTON_AFTER;
    if (isCourseScope ? isLoadingCourseDoc : isLoadingLesson) return;
    pendingScroll = { file: currentFile, top };
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(flushPendingScroll, SCROLL_SAVE_DEBOUNCE_MS);
  }

  async function flushPendingScroll() {
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = undefined;
    if (pendingScroll && courseId) {
      const { file, top } = pendingScroll;
      pendingScroll = null;
      try {
        await apiFetch(`/api/courses/${courseId}/checkpoints/position`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file, verticalPosition: top })
        });
        const existing = checkpoints.find((c) => c.type === 'position' && c.file === file);
        if (existing) {
          existing.verticalPosition = top;
          existing.date = new Date().toISOString();
        } else {
          checkpoints.push({
            id: `cp_pos_${Date.now()}`,
            file,
            verticalPosition: top,
            type: 'position',
            date: new Date().toISOString()
          });
        }
      } catch (e) {
        console.warn('Failed to record position checkpoint:', e);
      }
    }
  }

  function scrollWorkspaceToTop() {
    contentScroller?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Restore position or open linked checkpoint when content is in DOM
  $effect(() => {
    const isLoading = isCourseScope ? isLoadingCourseDoc : isLoadingLesson;
    if (isLoading || !contentScroller) return;

    const file = currentFile;
    const queryCheckpointId = $page.url.searchParams.get('checkpoint');

    // 1. If there's a target checkpoint in the query parameter, handle it once
    if (queryCheckpointId) {
      if (queryCheckpointId !== lastHandledCheckpointQuery) {
        const target = checkpoints.find((c) => c.id === queryCheckpointId);
        if (target) {
          lastHandledCheckpointQuery = queryCheckpointId;
          lastRestoredFile = file;

          // Give 60px breathing space above the note so it's not flush against the top edge
          const targetTop = Math.max(0, target.verticalPosition - 60);
          contentScroller.scrollTop = targetTop;
          showScrollTop = targetTop > SCROLL_TOP_BUTTON_AFTER;

          untrack(() => {
            const next = new Set(openNoteIds);
            next.add(target.id);
            openNoteIds = next;
          });

          // Clean up the URL parameter cleanly in SvelteKit
          try {
            const cleanUrl = new URL($page.url);
            cleanUrl.searchParams.delete('checkpoint');
            replaceState(cleanUrl.pathname + cleanUrl.search, $page.state);
          } catch {}
          return;
        }
      } else {
        // Already handled this checkpoint query
        return;
      }
    } else {
      lastHandledCheckpointQuery = '';
    }

    // 2. Only restore scroll position once per file load/switch
    if (file === lastRestoredFile) {
      return;
    }

    lastRestoredFile = file;
    const pos = untrack(() => checkpoints.find((c) => c.type === 'position' && c.file === file));
    if (pos && pos.verticalPosition > 0) {
      contentScroller.scrollTop = pos.verticalPosition;
    } else {
      contentScroller.scrollTop = 0;
    }
    showScrollTop = contentScroller.scrollTop > SCROLL_TOP_BUTTON_AFTER;
  });

  let checkpointErrorMessage = $state('');
  let checkpointErrorTimer: ReturnType<typeof setTimeout> | undefined;

  function showCheckpointError(message: string) {
    checkpointErrorMessage = message;
    clearTimeout(checkpointErrorTimer);
    checkpointErrorTimer = setTimeout(() => {
      checkpointErrorMessage = '';
    }, 6000);
  }

  /**
   * Saves a highlight checkpoint. All identity (course, file, anchor,
   * selection) is snapshotted up front so navigation while the request is in
   * flight cannot land the highlight on another document.
   */
  async function handleTriggerHighlight(verticalPosition: number) {
    if (!courseId) return;
    const snapshot = {
      courseId,
      file: currentFile,
      verticalPosition: activeSelection?.verticalPosition ?? verticalPosition,
      anchor: activeSelection?.anchor ?? ({ type: 'pixel', verticalPosition } as Anchor),
      selection:
        activeSelection?.selection ??
        (activeSelection?.text ? ({ text: activeSelection.text } as import('$lib/checkpoint').SelectionRange) : undefined)
    };

    try {
      const res = await apiFetch(`/api/courses/${snapshot.courseId}/checkpoints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: snapshot.file,
          verticalPosition: snapshot.verticalPosition,
          type: 'highlight',
          color: 'yellow',
          noteText: '',
          anchor: snapshot.anchor,
          ...(snapshot.selection ? { selection: snapshot.selection } : {})
        })
      });
      if (res.ok) {
        const body = await res.json();
        const saved: Checkpoint = body.checkpoint;
        checkpoints = [...checkpoints, saved];
        const next = new Set(openNoteIds);
        next.add(saved.id);
        openNoteIds = next;
        activeSelection = null;
      } else {
        showCheckpointError('Could not save the highlight — please try again.');
      }
    } catch (err) {
      console.error('Failed to save highlight checkpoint:', err);
      showCheckpointError('Could not save the highlight — check your connection and try again.');
    }
  }

  function handleTriggerNote(verticalPosition: number) {
    const targetVp = activeSelection?.verticalPosition ?? verticalPosition;
    const targetSelection =
      activeSelection?.selection ??
      (activeSelection?.text ? ({ text: activeSelection.text } as import('$lib/checkpoint').SelectionRange) : undefined);

    activeCheckpoint = {
      file: currentFile,
      verticalPosition: targetVp,
      anchor: activeSelection?.anchor ?? { type: 'pixel', verticalPosition: targetVp },
      selection: targetSelection,
      color: 'yellow',
      noteText: ''
    };
    isCheckpointModalOpen = true;
  }

  // ── Ask AI composer flow ───────────────────────────────────────────────────
  // Ask AI opens a composer with the captured quotation and a separate
  // question field; nothing is generated until the student submits.

  let aiComposer = $state<{
    courseId: string;
    file: string;
    verticalPosition: number;
    anchor: Anchor;
    selection?: import('$lib/checkpoint').SelectionRange;
    quote: string;
    courseTitle: string;
    lessonTitle: string;
    sourceTab: string;
    referenceText: string;
  } | null>(null);

  function handleTriggerAskAI(verticalPosition: number) {
    if (!courseId) return;
    const targetVp = activeSelection?.verticalPosition ?? verticalPosition;
    aiComposer = {
      courseId,
      file: currentFile,
      verticalPosition: targetVp,
      anchor: activeSelection?.anchor ?? { type: 'pixel', verticalPosition: targetVp },
      selection:
        activeSelection?.selection ??
        (activeSelection?.text ? ({ text: activeSelection.text } as import('$lib/checkpoint').SelectionRange) : undefined),
      quote: activeSelection?.text ?? '',
      courseTitle: course?.title || courseId.toUpperCase(),
      lessonTitle: currentLessonTitle || selectedLessonId,
      sourceTab: activeTab,
      referenceText: stripLessonMedia(currentReferenceMarkdown())
    };
  }

  /**
   * Reference material for an Ask-AI request: the FULL lesson for lesson-scope
   * files regardless of which tab the quote came from (a Summary quote still
   * sends the complete lesson); the document itself for course/unit docs.
   */
  function currentReferenceMarkdown(): string {
    if (isCourseScope || isUnitScope) {
      return parsedActiveTab.body || tabContents[activeTab] || '';
    }
    return tabContents.lesson || parsedActiveTab.body || tabContents[activeTab] || '';
  }

  async function handleAskAiSubmit(question: string): Promise<void | false> {
    const snap = aiComposer;
    if (!snap) return false;

    const activeModel = await getActiveLlmCard();
    if (!activeModel?.baseUrl) {
      // Keep the composer (and the typed question) intact; the settings modal
      // opens on top and the student can press Ask again afterwards.
      isLLMModalOpen = true;
      return false;
    }

    try {
      const res = await apiFetch(`/api/courses/${snap.courseId}/checkpoints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: snap.file,
          verticalPosition: snap.verticalPosition,
          type: 'ai',
          color: 'lavender',
          noteText: '',
          anchor: snap.anchor,
          ...(snap.selection ? { selection: snap.selection } : {}),
          aiQuestion: question,
          aiStatus: 'pending'
        })
      });
      if (!res.ok) {
        showCheckpointError('Could not save the AI question — please try again.');
        return false;
      }
      const body = await res.json();
      const cp: Checkpoint = body.checkpoint;
      aiComposer = null;
      // The in-page list only tracks the visible document.
      if (snap.courseId === courseId && snap.file === currentFile) {
        checkpoints = [...checkpoints, cp];
        const next = new Set(openNoteIds);
        next.add(cp.id);
        openNoteIds = next;
        activeSelection = null;
      }

      runCheckpointAi({
        checkpointId: cp.id,
        courseId: snap.courseId,
        question,
        quote: snap.quote,
        courseTitle: snap.courseTitle,
        lessonTitle: snap.lessonTitle,
        sourceTab: snap.sourceTab,
        referenceText: snap.referenceText
      });
    } catch (err) {
      console.error('Failed to create AI checkpoint:', err);
      showCheckpointError('Could not save the AI question — check your connection and try again.');
      return false;
    }
  }

  /**
   * Runs one AI generation for an existing checkpoint. Every await routes
   * back to the snapshot; the live route state is never consulted after the
   * request starts.
   */
  async function runCheckpointAi(snap: {
    checkpointId: string;
    courseId: string;
    question: string;
    quote: string;
    courseTitle: string;
    lessonTitle: string;
    sourceTab: string;
    referenceText: string;
  }) {
    const persist = async (patch: { aiAnswer?: string; aiStatus: 'done' | 'error' }) => {
      checkpoints = checkpoints.map((c) => (c.id === snap.checkpointId ? { ...c, ...patch } : c));
      try {
        const res = await apiFetch(`/api/courses/${snap.courseId}/checkpoints/${snap.checkpointId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch)
        });
        if (!res.ok) {
          console.warn(`Checkpoint AI save failed (${res.status}) for ${snap.checkpointId}`);
          showCheckpointError('The AI answer was generated but could not be saved — it may not survive a reload.');
        }
      } catch (err) {
        console.warn('Checkpoint AI save error:', err);
        showCheckpointError('The AI answer was generated but could not be saved — it may not survive a reload.');
      }
    };

    try {
      const activeModel = await getActiveLlmCard();
      if (!activeModel?.baseUrl) {
        await persist({
          aiAnswer: 'No AI model configured. Add a model in Settings → AI Models, then retry.',
          aiStatus: 'error'
        });
        return;
      }

      // Editable template from the Prompts system (seeded on load, never
      // overwritten). Falls back to the built-in default if unavailable.
      const systemPrompt = (genericPrompts['checkpoint_ask'] || DEFAULT_CHECKPOINT_ASK_PROMPT).trim();
      const userPrompt = buildCheckpointAskUserPrompt({
        courseTitle: snap.courseTitle,
        lessonTitle: snap.lessonTitle,
        sourceTab: snap.sourceTab,
        quote: snap.quote,
        question: snap.question,
        // Complete reference — never sliced; context-limit failures must be
        // visible errors, not silent truncation.
        referenceText: snap.referenceText
      });

      const res = await apiFetch('/api/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generate',
          sessionId: `${snap.courseId}-note`,
          systemPrompt,
          userPrompt
        })
      });

      if (res.ok) {
        const data = await res.json();
        const aiAnswer = data.completion || 'No answer generated.';
        await persist({ aiAnswer, aiStatus: 'done' });
      } else {
        const errText = (await res.text().catch(() => '')).slice(0, 300);
        console.error('AI Checkpoint generation failed:', res.status, errText);
        await persist({
          aiAnswer: `Failed to generate an AI answer (${res.status}). ${errText || 'Tap retry.'}`,
          aiStatus: 'error'
        });
      }
    } catch (err: any) {
      console.error('AI Checkpoint generation error:', err);
      await persist({ aiAnswer: 'AI generation error — tap retry.', aiStatus: 'error' });
    }
  }

  /**
   * Retry a failed AI checkpoint. Rebuilds the reference text from the
   * checkpoint's own file: the loaded lesson when still available, otherwise
   * a fresh fetch of that lesson's bundle.
   */
  async function handleRetryCheckpointAi(cp: Checkpoint) {
    if (cp.aiStatus !== 'error' || !cp.aiQuestion || !courseId) return;
    const retryCourseId = courseId;
    const retryCourseTitle = course?.title || retryCourseId.toUpperCase();
    const parsed = parseDocFileName(cp.file);
    if (!parsed) return;

    let referenceText = '';
    let lessonTitle = currentLessonTitle || '';
    let sourceTab = parsed.tab;

    if (parsed.isCourseScope || parsed.isUnitScope) {
      if (cp.file === currentFile) {
        referenceText = parsedActiveTab.body || tabContents[activeTab] || '';
        sourceTab = activeTab;
      } else {
        showCheckpointError('Reopen this document, then retry the AI question from there.');
        return;
      }
    } else {
      // Lesson scope: always the full lesson, independent of the quote's tab.
      if (parsed.lessonId === selectedLessonId && tabContents.lesson) {
        referenceText = tabContents.lesson;
        sourceTab = cp.file === currentFile ? activeTab : parsed.tab;
      } else {
        try {
          const res = await apiFetch(`/api/courses/${retryCourseId}/${encodeURIComponent(parsed.lessonId)}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          const bundle = data.bundle || data;
          referenceText = bundle.lesson || bundle.tabs?.lesson || '';
          lessonTitle = bundle.title || lessonTitle;
        } catch (err) {
          console.warn('Retry could not load lesson context:', err);
          showCheckpointError('Could not load the lesson for this question — check your connection and retry.');
          return;
        }
      }
    }

    if (courseId === retryCourseId) {
      checkpoints = checkpoints.map((c) => (c.id === cp.id ? { ...c, aiStatus: 'pending' } : c));
    }
    apiFetch(`/api/courses/${retryCourseId}/checkpoints/${cp.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aiStatus: 'pending' })
    }).catch(() => {});

    await runCheckpointAi({
      checkpointId: cp.id,
      courseId: retryCourseId,
      question: cp.aiQuestion,
      quote: cp.selection?.text || '',
      courseTitle: retryCourseTitle,
      lessonTitle,
      sourceTab,
      referenceText: stripLessonMedia(referenceText)
    });
  }

  function handleToggleCheckpoint(cp: Checkpoint) {
    const next = new Set(openNoteIds);
    if (next.has(cp.id)) {
      next.delete(cp.id);
    } else {
      next.add(cp.id);
    }
    openNoteIds = next;
  }

  function handleCloseCheckpoint(cp: Checkpoint) {
    const next = new Set(openNoteIds);
    next.delete(cp.id);
    openNoteIds = next;
  }

  function handleEditCheckpoint(cp: Checkpoint) {
    activeCheckpoint = cp;
    isCheckpointModalOpen = true;
  }

  async function handleSaveCheckpoint(data: { color: string; noteText: string }) {
    if (!activeCheckpoint || !courseId) return;
    try {
      const res = await apiFetch(`/api/courses/${courseId}/checkpoints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: activeCheckpoint.id,
          file: activeCheckpoint.file || currentFile,
          verticalPosition: activeCheckpoint.verticalPosition ?? contentScroller?.scrollTop ?? 0,
          color: data.color,
          noteText: data.noteText,
          ...(activeCheckpoint.anchor ? { anchor: activeCheckpoint.anchor } : {}),
          ...(activeCheckpoint.selection ? { selection: activeCheckpoint.selection } : {})
        })
      });
      if (res.ok) {
        const body = await res.json();
        const saved: Checkpoint = body.checkpoint;
        const idx = checkpoints.findIndex((c) => c.id === saved.id);
        if (idx !== -1) {
          checkpoints[idx] = saved;
        } else {
          checkpoints = [...checkpoints, saved];
        }
        // Keep the saved note open as a post-it note on the page
        const next = new Set(openNoteIds);
        next.add(saved.id);
        openNoteIds = next;
      }
    } catch (e) {
      console.error('Failed to save checkpoint note:', e);
      alert('Could not save checkpoint note.');
    }
  }

  async function handleDeleteCheckpoint(cp?: Checkpoint) {
    const target = cp || activeCheckpoint;
    if (!target?.id || !courseId) return;
    try {
      const res = await apiFetch(`/api/courses/${courseId}/checkpoints/${target.id}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        checkpoints = checkpoints.filter((c) => c.id !== target.id);
        const next = new Set(openNoteIds);
        next.delete(target.id);
        openNoteIds = next;
        if (activeCheckpoint?.id === target.id) {
          isCheckpointModalOpen = false;
          activeCheckpoint = null;
        }
      }
    } catch (e) {
      console.error('Failed to delete checkpoint note:', e);
      alert('Could not delete checkpoint note.');
    }
  }

  // Default prompt for active tab
  let defaultPromptForActiveTab = $derived.by(() => {
    if (activeTab === 'lesson') return '';
    if (isCourseScope) {
      return genericPrompts[`course_${activeTab}`] || genericPrompts[activeTab] || '';
    }
    if (isUnitScope) {
      return genericPrompts[`unit_${activeTab}`] || genericPrompts[activeTab] || '';
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
    if (activeTab === 'notes' || activeTab === 'studysheet') return 'Notes';
    if (activeTab === 'assignments') return 'Assignments';
    if (activeTab === 'test') return isUnitScope ? 'Unit Test' : isCourseScope ? 'Course Test' : 'Practice Test';
    if (activeTab === 'schedule') return 'Schedule';
    if (activeTab === 'logs') return 'Logs';
    if (isCustomTabSlug(activeTab)) return customTabDisplayName(activeTab);
    return isCourseScope ? 'Course Notes' : 'Notes';
  });

  // Check if current tab has unsaved changes
  let hasUnsavedChanges = $derived(
    tabContents[activeTab] !== originalContents[activeTab]
  );

  // Character count for current document (lessons, summary, notes, etc.)
  let pageCharCount = $derived.by(() => {
    if (activeTab === 'schedule') return 0;
    if (activeTab === 'test') return 0;
    if (
      activeTab !== 'lesson' &&
      activeTab !== 'summary' &&
      activeTab !== 'notes' &&
      activeTab !== 'studysheet' &&
      !isCustomTabSlug(activeTab)
    ) {
      return 0;
    }
    const body = parsedActiveTab.body || '';
    return body.trim().length;
  });

  async function loadPrompts() {
    try {
      const res = await apiFetch('/api/prompts');
      if (res.ok) {
        const data = await res.json();
        const map: Record<string, string> = {};
        for (const p of data.prompts || []) {
          map[p.id] = p.content;
        }
        // Seed the Ask-AI template only when the Prompts system does not have
        // it yet; a saved copy is the user's customization and wins.
        if (!map['checkpoint_ask']) {
          map['checkpoint_ask'] = DEFAULT_CHECKPOINT_ASK_PROMPT;
          apiFetch('/api/prompts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: 'checkpoint_ask', content: DEFAULT_CHECKPOINT_ASK_PROMPT })
          }).catch((e) => console.warn('Failed to seed checkpoint_ask prompt:', e));
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
        await Promise.all([loadCheckpoints(), loadCourseSchedule()]);
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
    if (tab === 'lesson' || tab === 'book') {
      isLoadingCourseDoc = false;
      tabContents[tab] = '';
      originalContents[tab] = '';
      return;
    }
    isLoadingCourseDoc = true;
    try {
      const res = await apiFetch(`/api/courses/${courseId}/course-docs?type=${tab}`);
        if (res.ok) {
          const data = await res.json();
          if (data.exists && data.markdown && data.markdown.trim().length > 0) {
            if (tab === 'schedule') {
              courseScheduleMarkdown = data.markdown;
            }
            tabContents[tab] = data.markdown;
            originalContents[tab] = data.markdown;
            quizRunnerKey++;
          } else if (tab === 'schedule') {
            // Schedules need the preferences questionnaire first — show the
            // intro panel instead of silently calling the LLM.
            tabContents.schedule = '';
            originalContents.schedule = '';
          } else if (tab === 'logs') {
            const defaultLogs = '# Course Logs\n\n| Date | Type | Lesson | Tokens |\n| :--- | :--- | :--- | :--- |\n';
            tabContents.logs = data.markdown || defaultLogs;
            originalContents.logs = tabContents.logs;
          } else if (['summary', 'notes', 'studysheet', 'test'].includes(tab)) {
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
        'Core prompt template for course schedule is missing. Please add course_schedule.md in Prompts before generating.'
      );
      return;
    }

    console.group(
      `%c[Schedule Builder] Enqueueing Generation for ${(courseId || '').toUpperCase()}`,
      'color: #2563eb; font-weight: bold;'
    );
    console.log('Target Model & Endpoint:', {
      model: activeModel.model || activeModel.label || '(server default)',
      provider: activeModel.provider,
      baseUrl: activeModel.baseUrl
    });
    console.log('--- SYSTEM PROMPT TEMPLATE & PREFERENCES ---\n' + promptWithPreferences);
    console.log('--- PREFERENCES OBJECT ---', preferences);
    console.log(
      'Note: The background worker will generate the deterministic RRule timeline and send the enrichment request to the LLM. ' +
      'When complete, the full RRule timeline, exact LLM request, and exact LLM response will be logged here.'
    );
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

  async function generateCourseDocument(
    type: PageTab,
    opts?: { customPrompt?: string; customContent?: string; contextAttachment?: string; cardId?: string }
  ) {
    if (type === 'lesson' || !['summary', 'notes', 'studysheet', 'test', 'schedule'].includes(type)) return;

    const normalizedType = type === 'studysheet' ? 'notes' : type;
    const promptKey = normalizedType === 'schedule' ? 'course_schedule' : `course_${normalizedType}`;
    const activePrompt =
      opts?.customPrompt ||
      parsedActiveTab.frontmatter.prompt ||
      genericPrompts[promptKey] ||
      genericPrompts[normalizedType] ||
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
          customContent: opts?.customContent,
          contextAttachment: opts?.contextAttachment || parsedActiveTab.frontmatter.contextAttachment,
          cardId: opts?.cardId,
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

      const tokensUsed = data.usage?.total_tokens ?? data.tokensUsed;
      const tokenBreakdown = data.usage?.prompt_tokens !== undefined
        ? ` (prompt: ${data.usage.prompt_tokens.toLocaleString()}, completion: ${data.usage.completion_tokens?.toLocaleString() ?? '?'})`
        : '';
      const tokenStr = tokensUsed !== undefined ? ` | Total tokens used: ${tokensUsed.toLocaleString()}${tokenBreakdown}` : '';
      console.log(`[Course AI] Generated course ${type}: ${generatedMarkdown.length.toLocaleString()} characters${tokenStr}`, {
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
          course.courseDocs = { summary: false, notes: false, test: false, schedule: false };
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
    isMobileTabDropdownOpen = false;
    console.log(`[NAV] switchTab "${tab}" | scope=${isCourseScope} unit=${isUnitScope} lesson=${selectedLessonId}`);
    if (isCourseScope && !hasCourseDoc(tab)) {
      console.log(`[NAV] switchTab: "${tab}" has no course doc → falling back to lesson`);
      tab = 'lesson';
    }
    activeTab = tab;
    isEditing = false;
    showPromptCard = false;
    if (courseId) {
      setCourseLastLocation(courseId, {
        tab,
        lessonId: isCourseScope ? 'course' : selectedLessonId,
        isCourseScope,
        isUnitScope
      });
    }
    const tabSuffix = (tab !== 'lesson' || isUnitScope) ? `/${tab}` : '';
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
    if (lessonId === 'course') {
      isCourseScope = true;
      selectedLessonId = 'course';
      isEditing = false;
      showPromptCard = false;
      isLessonActionsOpen = false;
      isMobileTabDropdownOpen = false;
      if (activeTab !== 'test' && activeTab !== 'logs' && activeTab !== 'book') {
        activeTab = 'test';
      }
      if (courseId) {
        setCourseLastLocation(courseId, {
          tab: activeTab,
          lessonId: 'course',
          isCourseScope: true,
          isUnitScope: false
        });
      }
      await loadCourseDocument(activeTab);
      const targetUrl = `/courses/${(courseId || '').toLowerCase()}/course/${activeTab}`;
      if ($page.url.pathname !== targetUrl) {
        nav(targetUrl);
      }
      return;
    }
    isCourseScope = false;
    isEditing = false;
    showPromptCard = false;
    isLessonActionsOpen = false;
    isMobileTabDropdownOpen = false;
    if (isUnitScopeId(lessonId)) {
      if (activeTab !== 'assignments' && activeTab !== 'test' && !isCustomTabSlug(activeTab)) {
        activeTab = 'assignments';
      }
    } else {
      if (activeTab === 'schedule' || activeTab === 'assignments' || activeTab === 'test') {
        activeTab = 'lesson';
      }
    }
    await loadLesson(lessonId);
    console.log(`[NAV] selectLesson loaded → tab=${activeTab}`);
    const targetTab = activeTab;
    if (courseId) {
      setCourseLastLocation(courseId, {
        tab: targetTab,
        lessonId,
        isCourseScope: false,
        isUnitScope: isUnitScopeId(lessonId)
      });
    }
    const tabSuffix = targetTab && (targetTab !== 'lesson' || isUnitScopeId(lessonId)) ? `/${targetTab}` : '';
    const targetUrl = `/courses/${(courseId || '').toLowerCase()}/${encodeURIComponent(lessonId)}${tabSuffix}`;
    if ($page.url.pathname !== targetUrl) {
      nav(targetUrl);
    } else {
      console.log(`[NAV] selectLesson: URL already ${targetUrl}, no goto needed`);
    }
  }

  /** Monotonic token for loadLesson calls — the newest invocation wins. */
  let lessonLoadSeq = 0;

  /** Loose lesson-ref equality tolerating zero-padding ("1-2" ≡ "01-02"). */
  function sameLessonRef(a: string | undefined, b: string): boolean {
    if (!a) return false;
    const norm = (s: string) => {
      const m = s.toLowerCase().match(/^(\d+)[.-](\d+)(.*)$/);
      return m ? `${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}${m[3]}` : s.toLowerCase();
    };
    return norm(a) === norm(b);
  }

  async function loadLesson(lessonId: string) {
    const seq = ++lessonLoadSeq;
    console.log(`[NAV] loadLesson "${lessonId}" …`);
    selectedLessonId = lessonId;
    unitTestSupervisorMessage = '';
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
        // Defensive normalization: guarantee data.tabs exists
        if (!data.tabs) {
          data.tabs = {};
          if ((data as any).summary) data.tabs.summary = (data as any).summary;
          if ((data as any).notes) data.tabs.notes = (data as any).notes;
          if ((data as any).test) data.tabs.test = (data as any).test;
        }
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
        if (courseScheduleMarkdown) {
          tabContents.schedule = courseScheduleMarkdown;
        }
        originalContents = { ...tabContents };
        if (courseId) {
          lessonViewMode = getLessonViewMode(courseId);
        }
        quizRunnerKey++;
        console.log(`[NAV] loadLesson "${lessonId}" ✓ lessonLen=${(data.lesson || '').length}, tabs=[${Object.keys(data.tabs || {}).join(', ') || 'none'}], activeTab="${activeTab}", activeTabLen=${(tabContents[activeTab] || '').length}`);
      } else {
        console.warn(`[NAV] loadLesson "${lessonId}" failed: HTTP ${res.status}`);
      }
    } catch (e) {
      console.error('Failed to load lesson:', e);
    } finally {
      isLoadingLesson = false;
    }
  }

  function toggleLessonViewMode() {
    const next = lessonViewMode === 'original' ? 'markdown' : 'original';
    lessonViewMode = next;
    if (courseId) {
      setLessonViewMode(courseId, next);
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
    const confirmed = await confirmDialog(
      `Delete the "${name}" tab for lesson ${selectedLessonId}? This removes ${selectedLessonId}.${slug}.md from disk.`,
      'Delete Tab'
    );
    if (!confirmed) {
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
      if (wasActive) {
        switchTab('lesson');
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
    courseScheduleMarkdown = updatedMarkdown;
    tabContents.schedule = updatedMarkdown;
    tabContents = { ...tabContents };
    await saveCurrentTab();
  }

  /** Regenerate the schedule through the preferences questionnaire. */
  function handleScheduleRebuild() {
    isScheduleModalOpen = true;
  }

  function handleScheduleGenerate(promptWithPreferences: string, preferences?: SchedulePreferences, customTemplate?: string) {
    if (customTemplate && isCourseScope && activeTab === 'schedule') {
      handlePromptChange(customTemplate);
    }
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

  let isExtendingPage: boolean = $state(false);
  let extendBtnEl = $state<HTMLButtonElement>();

  async function handleExtendPage() {
    if (isExtendingPage) return;
    if (activeTab === 'book' || activeTab === 'schedule' || activeTab === 'test') return;

    isExtendingPage = true;
    try {
      const raw = tabContents[activeTab] || '';
      tabContents[activeTab] = extendMarkdownContent(raw, activeTab === 'lesson');
      await saveCurrentTab();

      tick().then(() => {
        extendBtnEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    } finally {
      isExtendingPage = false;
    }
  }

  async function triggerAIGeneration(opts?: {
    customPrompt?: string;
    customContent?: string;
    contextAttachment?: string;
    cardId?: string;
  }) {
    if (activeTab === 'lesson') return;

    const activeModel = await getActiveLlmCard();
    if (!activeModel?.baseUrl) {
      isLLMModalOpen = true;
      return;
    }

    try {
      const activeSystemPrompt =
        opts?.customPrompt || parsedActiveTab.frontmatter.prompt || defaultPromptForActiveTab;

      console.log(`\n[ILC AI Enqueue: ${tabDisplayName}]`);
      console.log(`- Course: ${(courseId || '').toUpperCase()} | Lesson: ${selectedLessonId} (${currentLessonTitle})`);
      console.log(`- Endpoint: ${activeModel.baseUrl}`);
      console.log(`- Model: ${activeModel.model || '(server default)'}`);
      console.log(`- System Prompt: "${activeSystemPrompt.slice(0, 120)}..."`);

      const rawAttachment = opts?.contextAttachment || parsedActiveTab.frontmatter.contextAttachment;
      const isLesson = selectedLessonId && !isUnitScopeId(selectedLessonId);
      const effectiveAttachment =
        isLesson && (!rawAttachment || rawAttachment === 'lesson - summaries' || rawAttachment === 'lesson - studysheets' || rawAttachment === 'lesson - notes')
          ? 'lesson - lessons'
          : (rawAttachment || (isUnitScopeId(selectedLessonId) ? 'unit - lessons' : 'lesson - lessons'));

      const res = await apiFetch('/api/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'enqueue',
          courseId,
          lessonId: selectedLessonId,
          lessonTitle: currentLessonTitle,
          tab: activeTab,
          customPrompt: activeSystemPrompt,
          customContent: opts?.customContent,
          contextAttachment: effectiveAttachment,
          cardId: opts?.cardId
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

  let unitTestSupervisorMessage: string = $state('');

  async function handleSubmitUnitTest(answers: Record<string, string>) {
    if (!courseId) return;
    const targetUnitId = isCourseScope ? 'course' : selectedLessonId;
    if (!targetUnitId) return;

    try {
      const res = await apiFetch(`/api/courses/${courseId}/unit-test/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          unitId: targetUnitId,
          testMarkdown: tabContents.test,
          answers
        })
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.message || data.error || 'Failed to submit test');
      }

      // Update local tab contents and frontmatter so UI reflects the newly saved attempt immediately
      if (data.updatedMarkdown) {
        tabContents.test = data.updatedMarkdown;
        originalContents.test = data.updatedMarkdown;
      }

      if (data.supervisorMessage) {
        unitTestSupervisorMessage = data.supervisorMessage;
      }

      saveSuccessMessage = `${isCourseScope ? 'Course practice test' : 'Unit test'} evaluated: ${data.score}/${data.total} (${data.percentage}%)`;
      setTimeout(() => {
        saveSuccessMessage = '';
      }, 4000);

      return data;
    } catch (err: any) {
      console.error('[Test Submit Error]', err);
      alert('Error evaluating test: ' + (err?.message || 'Check connection'));
      throw err;
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
        const tokensUsed = task.tokensUsed;
        const tokenStr = tokensUsed !== undefined ? ` | Total tokens used: ${tokensUsed.toLocaleString()}` : '';
        console.log(`[ILC AI Done] ${label} for ${task.courseId.toUpperCase()} ${task.lessonId} generated${tokenStr}.`);
        saveSuccessMessage = `✨ ${label} generated!`;
        setTimeout(() => {
          saveSuccessMessage = '';
        }, 3500);

        if (task.tab === 'schedule') {
          await loadCourseDocument('schedule');
          if (course) {
            if (!course.courseDocs) {
              course.courseDocs = { summary: false, notes: false, test: false, schedule: false };
            }
            course.courseDocs.schedule = true;
          }

          const generatedMarkdown = tabContents.schedule;
          const debug = task.scheduleDebug;

          console.group(
            `%c[Schedule Builder] Full LLM & RRule Log for ${(task.courseId || '').toUpperCase()}`,
            'color: #059669; font-weight: bold; font-size: 13px;'
          );

          // 1. Full Course-Timeline generated by RRule
          console.group('%c1. Full Course-Timeline Generated by RRule', 'font-weight: bold; color: #2563eb;');
          if (debug?.rruleTimeline) {
            console.log(
              `Generated Study Dates (${debug.rruleTimeline.dates?.length || 0} days):`,
              debug.rruleTimeline.dates
            );
            console.log(
              `Planned Sessions (${debug.rruleTimeline.totalSessions || debug.rruleTimeline.sessions?.length || 0} slots):`,
              debug.rruleTimeline.sessions
            );
            console.log('--- FULL SKELETON MARKDOWN (Generated by RRule) ---\n' + debug.rruleTimeline.markdownSkeleton);
          } else {
            console.log('(RRule timeline metadata not available in task object)');
          }
          console.groupEnd();

          // 2. Actual Content Sent to the LLM
          console.group('%c2. Actual Content Sent to LLM', 'font-weight: bold; color: #7c3aed;');
          if (debug?.llmRequest) {
            console.log('Target Model & Endpoint:', {
              model: debug.llmRequest.model,
              endpoint: debug.llmRequest.endpoint
            });
            console.log('--- SYSTEM PROMPT ---\n' + debug.llmRequest.systemPrompt);
            console.log('--- USER PROMPT (ENRICHMENT PAYLOAD) ---\n' + debug.llmRequest.userPrompt);
          } else {
            console.log('(LLM request metadata not available in task object)');
          }
          console.groupEnd();

          // 3. Exact Data Sent Back from the LLM
          console.group('%c3. Exact Data Sent Back from LLM', 'font-weight: bold; color: #0d9488;');
          if (debug?.llmResponse) {
            console.log('--- EXACT RAW LLM RESPONSE ---\n' + (debug.llmResponse.rawCompletion || '(empty response)'));
            console.log(`Extracted JSON Patches (${debug.llmResponse.patchesCount}):`, debug.llmResponse.patches);
            console.log('Enrichment Applied to Skeleton:', debug.llmResponse.applied);
            console.log('Structural Equivalence Gate Passed:', debug.llmResponse.gatePassed);
            if (debug.llmResponse.error) {
              console.warn('Enrichment Notice / Error:', debug.llmResponse.error);
            }
          } else {
            console.warn('No LLM response recorded (enrichment may have timed out or failed).');
          }
          console.groupEnd();

          // 4. Itemized Checklist Events Parsed from Final Output
          if (generatedMarkdown && generatedMarkdown.trim().length > 0) {
            const parsed = ScheduleParser.parseMarkdown(generatedMarkdown);
            console.groupCollapsed(`4. Parsed Checklist Events (${parsed.events.length} items):`);
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
          }

          // 5. Final Saved Schedule (Markdown)
          console.groupCollapsed('5. Final Saved Schedule (Markdown)');
          console.log(generatedMarkdown);
          console.groupEnd();

          console.groupEnd();
        } else if (isCourseScope) {
          if (task.lessonId === 'course' || task.tab === activeTab) {
            await loadCourseDocument(activeTab);
            quizRunnerKey++;
          }
        } else if (task.lessonId === selectedLessonId) {
          await loadLesson(selectedLessonId);
          quizRunnerKey++;
        }
      } else if (task.status === 'failed') {
        console.error(`[ILC AI Failed] ${label} for ${task.lessonId}: ${task.error}`);
        if (task.tab === 'schedule' && task.scheduleDebug) {
          const debug = task.scheduleDebug;
          console.group(
            `%c[Schedule Builder] Failed Generation Inspection for ${(task.courseId || '').toUpperCase()}`,
            'color: #dc2626; font-weight: bold;'
          );
          if (debug.rruleTimeline) {
            console.group('Full Course-Timeline Generated by RRule');
            console.log('Skeleton Markdown:\n' + debug.rruleTimeline.markdownSkeleton);
            console.log('Planned Sessions:', debug.rruleTimeline.sessions);
            console.groupEnd();
          }
          if (debug.llmRequest) {
            console.group('Actual Content Sent to LLM');
            console.log('System Prompt:\n' + debug.llmRequest.systemPrompt);
            console.log('User Prompt (Enrichment Payload):\n' + debug.llmRequest.userPrompt);
            console.groupEnd();
          }
          if (debug.llmResponse) {
            console.group('Exact Data Sent Back from LLM');
            console.log('Raw Completion:\n' + debug.llmResponse.rawCompletion);
            console.log('Error:', debug.llmResponse.error);
            console.groupEnd();
          }
          console.groupEnd();
        }
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
          tabs: ['summary', 'notes', 'test']
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
    // Configuring the model from Ask AI must not regenerate the open tab.
    // The composer retains the question so the student can submit it again.
    if (aiComposer) return;
    if (isCourseScope && activeTab === 'schedule') {
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
        await exportDocumentToPdf({
          courseCode: course.id,
          courseTitle: course.title,
          lessonId: 'Course',
          lessonTitle: 'Final Course Practice Exam',
          tab: 'test',
          tabDisplayName: 'Course Practice Test',
          rawMarkdown: tabContents.test
        });
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

  // Markup drawing requires the rendered reader; leave the mode when editing.
  $effect(() => {
    if (isEditing) exitMarkupMode();
  });

  function handleKeydown(e: KeyboardEvent) {
    if (markupUi.mode && course && (e.metaKey || e.ctrlKey)) {
      if ((e.key === 'z' || e.key === 'Z') && e.shiftKey) {
        e.preventDefault();
        markupRedo(course.id, currentFile);
        return;
      }
      if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault();
        markupRedo(course.id, currentFile);
        return;
      }
      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        markupUndo(course.id, currentFile);
        return;
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      if (isEditing) {
        handleSaveEdit();
      } else {
        saveCurrentTab();
      }
    } else if (e.key === 'Escape') {
      if (isActionMenuOpen) {
        isActionMenuOpen = false;
      }
      if (isEditing) {
        handleCancelEdit();
      }
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

  function handleNavigateFromLesson(rawTarget: string, isAssignment?: boolean) {
    if (!course || !course.units) return;
    const allLessons = course.units.flatMap((u) => u.lessons);
    let match = findLesson(allLessons, rawTarget);
    if (!match && isAssignment) {
      match = findLesson(allLessons, `${rawTarget}_assign1`);
    }
    if (!match) {
      // Strip course prefix (e.g. mhf4u_01.02 -> 01.02, mhf4u_u4la9 -> u4la9)
      const stripped = rawTarget.replace(/^[a-z0-9]+[_-]/i, '');
      if (stripped !== rawTarget) {
        match = findLesson(allLessons, stripped);
        if (!match && isAssignment) {
          match = findLesson(allLessons, `${stripped}_assign1`);
        }
      }
    }
    if (!match) {
      // Try fuzzy matching pattern like u4la9 or mhf4u_u4la9_assign_1
      const ula = rawTarget.match(/u(\d+)la(\d+)(?:_assign_?(\d+))?/i);
      if (ula) {
        const uNum = parseInt(ula[1], 10);
        const lNum = parseInt(ula[2], 10);
        const assignNum = ula[3] || (isAssignment ? '1' : '');
        const candId = assignNum
          ? `${String(uNum).padStart(2, '0')}-${String(lNum).padStart(2, '0')}_assign${assignNum}`
          : `${String(uNum).padStart(2, '0')}-${String(lNum).padStart(2, '0')}`;
        match =
          allLessons.find((l) => l.id.toLowerCase() === candId.toLowerCase()) ||
          allLessons.find((l) => l.unitNumber === uNum && l.lessonNumber === lNum);
      }
    }
    if (!match) {
      // Match by unit and lesson numbers extracted from string (e.g. mhf4u_01.02 or 01.01.03)
      const subDot = rawTarget.match(/(\d{1,2})[.-](\d{1,2})/);
      if (subDot) {
        const uNum = parseInt(subDot[1], 10);
        const lNum = parseInt(subDot[2], 10);
        match = allLessons.find((l) => l.unitNumber === uNum && l.lessonNumber === lNum);
      }
    }
    if (match) {
      goto(`/courses/${course.id}/${match.id}/lesson`);
    } else {
      console.warn(`[LessonNavigation] Could not find lesson matching target: ${rawTarget}`);
    }
  }

  let isRouteSyncing = false;

  function parseTabName(t?: string | null): PageTab | null {
    if (!t) return null;
    const clean = t.toLowerCase().trim();
    if (clean === 'cheatsheet' || clean === 'studysheet') return 'notes';
    if (['lesson', 'summary', 'notes', 'test', 'schedule', 'assignments', 'book'].includes(clean)) {
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

    // 2. Normalized zero-padded ID (e.g. "1-2" -> "01-02", "1-02" -> "01-02")
    const normIdMatch = clean.match(/^(\d+)[.-](\d+)(.*)$/);
    if (normIdMatch) {
      const padded = `${normIdMatch[1].padStart(2, '0')}-${normIdMatch[2].padStart(2, '0')}${normIdMatch[3]}`;
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

  function getCanonicalTarget(canonicalPath: string): string | null {
    const currentPath = $page.url.pathname;
    const searchParams = new URLSearchParams($page.url.search);
    const hasLegacyRoutingParams =
      searchParams.has('scope') || searchParams.has('lesson') || searchParams.has('tab');

    if (currentPath === canonicalPath && !hasLegacyRoutingParams) {
      return null;
    }

    searchParams.delete('scope');
    searchParams.delete('lesson');
    searchParams.delete('tab');
    const qs = searchParams.toString();
    return qs ? `${canonicalPath}?${qs}` : canonicalPath;
  }

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
        hasLoadedCheckpoints = false;
        await loadCourse(undefined, { skipAutoLesson: true });
        if (routeMovedOn()) throw ROUTE_MOVED_ON;
      }
      if (!course) return;

      const pLesson = $page.params.lesson;
      const pTab = $page.params.tab;
      const qScope = $page.url.searchParams.get('scope');
      const qLesson = $page.url.searchParams.get('lesson');
      const qTab = $page.url.searchParams.get('tab');

      // Generic course open (e.g. /courses/clm3u with no lesson/tab specified)
      const isGenericCourseOpen = !pLesson && !pTab && !qScope && !qLesson && !qTab;
      let resumeTarget: ReturnType<typeof resolveLastAccessedCourseRoute> = null;
      if (isGenericCourseOpen && getResumeLastPosition()) {
        if (!hasLoadedCheckpoints) {
          await loadCheckpoints();
        }
        const allLessons = (course.units || []).flatMap((u) => u.lessons);
        resumeTarget = resolveLastAccessedCourseRoute(courseId, checkpoints, allLessons);
        if (resumeTarget) {
          console.log(`[NAV] syncRoute: resolved resume target: lesson=${resumeTarget.lessonId} tab=${resumeTarget.tab} isCourseScope=${resumeTarget.isCourseScope}`);
        }
      }

      const isTargetCourse =
        (resumeTarget?.isCourseScope && (resumeTarget.tab === 'test' || resumeTarget.tab === 'logs' || resumeTarget.tab === 'book')) ||
        (pLesson === 'course' && (pTab === 'test' || pTab === 'logs' || pTab === 'book' || qTab === 'test' || qTab === 'logs' || qTab === 'book')) ||
        (qScope === 'course' && (pTab === 'test' || pTab === 'logs' || pTab === 'book' || qTab === 'test' || qTab === 'logs' || qTab === 'book'));

      if (isTargetCourse) {
        const targetTab: PageTab = (pTab === 'logs' || qTab === 'logs' || resumeTarget?.tab === 'logs')
          ? 'logs'
          : (pTab === 'book' || qTab === 'book' || resumeTarget?.tab === 'book')
            ? 'book'
            : 'test';

        const scopeChanged = !isCourseScope;
        const tabChanged = activeTab !== targetTab;

        isCourseScope = true;
        activeTab = targetTab;
        if (scopeChanged || tabChanged) {
          showPromptCard = false;
        }

        if (targetTab === 'book' && course?.id) {
          hasLoadedBookOnce = true;
          lastLoadedBookCourseId = course.id;
          recordCourseBookOpened(course.id);
        }

        if (courseId) {
          setCourseLastLocation(courseId, {
            tab: targetTab,
            lessonId: 'course',
            isCourseScope: true,
            isUnitScope: false
          });
        }

        if (scopeChanged || tabChanged || !tabContents[targetTab]) {
          await loadCourseDocument(targetTab);
          if (routeMovedOn()) throw ROUTE_MOVED_ON;
        }

        const canonical = `/courses/${courseId.toLowerCase()}/course/${targetTab}`;
        const canonicalTarget = getCanonicalTarget(canonical);
        if (canonicalTarget) {
          nav(canonicalTarget, { replace: true });
        }
      } else {
        const rawRequested = (pLesson || qLesson || '').trim();
        const isTargetUnit = isUnitScopeId(rawRequested);

        if (isTargetUnit) {
          const uNum = parseUnitNumber(rawRequested);
          const foundUnit = uNum !== null ? (course.units || []).find((u) => u.number === uNum) : null;
          const targetLesson = foundUnit ? formatUnitScopeId(foundUnit.number) : rawRequested;

          const parsed = parseTabName(pTab) || parseTabName(qTab);
          const targetTab: PageTab = parsed && (isUnitTab(parsed) || isCustomTabSlug(parsed)) ? parsed : 'assignments';

          const scopeChanged = isCourseScope;
          const lessonChanged = selectedLessonId !== targetLesson;
          const tabChanged = activeTab !== targetTab;

          isCourseScope = false;
          activeTab = targetTab;
          selectedLessonId = targetLesson;
          if (scopeChanged || lessonChanged || tabChanged) {
            showPromptCard = false;
          }

          if (scopeChanged || lessonChanged || !selectedLessonId) {
            await loadLesson(targetLesson);
            if (routeMovedOn()) throw ROUTE_MOVED_ON;
          }

          if (isCustomTabSlug(targetTab) && lessonBundle && !lessonBundle.tabs?.[targetTab]) {
            await createCustomTab(targetTab, customTabDisplayName(targetTab));
            if (routeMovedOn()) throw ROUTE_MOVED_ON;
          }

          if (courseId) {
            setCourseLastLocation(courseId, {
              tab: targetTab,
              lessonId: targetLesson,
              isCourseScope: false,
              isUnitScope: true
            });
          }

          const canonical = `/courses/${courseId.toLowerCase()}/${encodeURIComponent(targetLesson)}/${targetTab}`;
          const canonicalTarget = getCanonicalTarget(canonical);
          if (canonicalTarget) {
            nav(canonicalTarget, { replace: true });
          }
        } else {
          const allLessons = (course.units || []).flatMap((u) => u.lessons);
          const requestedLesson = (resumeTarget && !resumeTarget.isCourseScope && !isUnitScopeId(resumeTarget.lessonId))
            ? resumeTarget.lessonId
            : (pLesson !== 'course' ? (pLesson || qLesson || '') : '');
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

          let targetTab: PageTab = (resumeTarget && !resumeTarget.isCourseScope && !isUnitScopeId(resumeTarget.lessonId))
            ? resumeTarget.tab
            : (parseTabName(pTab) || parseTabName(qTab) || 'lesson');
          if (targetTab === 'schedule' || targetTab === 'assignments' || targetTab === 'test') {
            targetTab = 'lesson';
          }

          const scopeChanged = isCourseScope;
          const lessonChanged = selectedLessonId !== targetLesson;
          const tabChanged = activeTab !== targetTab;
          console.log(
            `[NAV] syncRoute lesson branch | target="${targetLesson}" targetTab=${targetTab} lessonChanged=${lessonChanged} scopeChanged=${scopeChanged}`
          );

          isCourseScope = false;
          activeTab = targetTab;
          if (scopeChanged || lessonChanged || tabChanged) {
            showPromptCard = false;
          }

          if (scopeChanged || lessonChanged || !selectedLessonId) {
            if (targetLesson) {
              await loadLesson(targetLesson);
              if (routeMovedOn()) throw ROUTE_MOVED_ON;
            }
          }

          // A URL naming a custom tab the lesson doesn't have yet (schedule
          // deep link, bookmark) creates the tab file so it can be used.
          if (isCustomTabSlug(targetTab) && lessonBundle && !lessonBundle.tabs?.[targetTab]) {
            await createCustomTab(targetTab, customTabDisplayName(targetTab));
            if (routeMovedOn()) throw ROUTE_MOVED_ON;
          }

          if (targetLesson) {
            if (courseId) {
              setCourseLastLocation(courseId, {
                tab: targetTab,
                lessonId: targetLesson,
                isCourseScope: false,
                isUnitScope: false
              });
            }
            const tabSuffix = targetTab !== 'lesson' ? `/${targetTab}` : '';
            const canonical = `/courses/${courseId.toLowerCase()}/${encodeURIComponent(targetLesson)}${tabSuffix}`;
            const canonicalTarget = getCanonicalTarget(canonical);
            if (canonicalTarget) {
              nav(canonicalTarget, { replace: true });
            }
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

  onMount(() => {
    installPerfObservers();
    void loadPrompts();
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
    if (lastLoadedBookCourseId) {
      const oldPath = `/api/courses/${lastLoadedBookCourseId}/assets/locker_docs/course.pdf`;
      void pdfCloseDocument(oldPath);
    }
  });

  // Current lesson title
  let currentLessonTitle = $derived.by(() => {
    if (!course) return '';
    if (isUnitScope && currentUnit) {
      return `Unit ${currentUnit.number}: ${currentUnit.title}`;
    }
    for (const u of course.units) {
      const found = u.lessons.find((l) => l.id === selectedLessonId);
      if (found) return found.title;
    }
    return '';
  });

  // First available lesson in course (for quick navigation from course overview)
  let firstLesson = $derived.by(() => {
    if (!course) return null;
    for (const u of course.units) {
      for (const l of u.lessons) {
        if (l.type === 'lesson') return l;
      }
    }
    return (course.units || []).flatMap((u) => u.lessons)[0] || null;
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
    } else if (isCourseScope) {
      if (lId === 'course' && tab === activeTab) {
        loadCourseDocument(activeTab);
        quizRunnerKey++;
      }
    } else if (!isCourseScope && lId === selectedLessonId) {
      loadLesson(selectedLessonId);
      quizRunnerKey++;
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
  <div class="flex-1 flex flex-col h-[calc(100vh-3.5rem)] w-full max-w-full min-w-0 overflow-hidden">
    <!-- Sub-Header: Lesson Selector & Tabs -->
    <div
      data-sub-header
      class="relative {isMobileTabDropdownOpen || isLessonActionsOpen ? 'z-40' : 'z-30'} border-b border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 px-2 sm:px-4 py-2 sm:py-2.5 flex items-center justify-between gap-1.5 xs:gap-2 sm:gap-3 shrink-0 w-full max-w-full"
    >
      <!-- Left: Lesson Selector & Add Chapters Button -->
      <div class="flex items-center space-x-1.5 sm:space-x-2 shrink min-w-0">
        <LessonSelector
          {course}
          selectedLessonId={isCourseScope ? 'course' : selectedLessonId}
          {activeTab}
          onSelectLesson={(id) => selectLesson(id)}
        />

        {#if !isCourseScope && !isUnitScope}
          <div class="relative shrink-0">
            <button
              type="button"
              onclick={() => (isLessonActionsOpen = !isLessonActionsOpen)}
              class="w-8 h-8 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-800 hover:bg-stone-100 dark:hover:bg-stone-700 flex items-center justify-center text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 transition shadow-2xs cursor-pointer {isLessonActionsOpen ? 'bg-stone-100 dark:bg-stone-700 text-stone-900 dark:text-stone-100 ring-2 ring-stone-400/20' : ''}"
              title="More options (Next Lesson, Add, Replace, Generate Missing)"
              aria-label="More lesson options"
              aria-expanded={isLessonActionsOpen}
            >
              <MoreHorizontal class="w-4 h-4" />
            </button>

            {#if isLessonActionsOpen}
              <!-- Click outside backdrop -->
              <div
                class="fixed inset-0 z-40"
                onclick={() => (isLessonActionsOpen = false)}
                aria-hidden="true"
              ></div>

              <div
                role="menu"
                tabindex="-1"
                class="absolute left-0 mt-1.5 w-52 rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 shadow-xl z-50 py-1 text-xs divide-y divide-stone-100 dark:divide-stone-800 animate-in fade-in zoom-in-95 duration-100"
              >
                <!-- Next Lesson option -->
                <div class="py-1">
                  <button
                    type="button"
                    role="menuitem"
                    onclick={goToNextLesson}
                    disabled={!nextLessonItem}
                    class="flex w-full items-center justify-between px-3 py-2 text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer text-left font-medium"
                    title={nextLessonItem ? `Go to next lesson: ${nextLessonItem.title || nextLessonItem.id}` : 'No next lesson'}
                  >
                    <div class="flex items-center space-x-2 truncate">
                      <ChevronRight class="w-3.5 h-3.5 text-stone-500 dark:text-stone-400 shrink-0" />
                      <span class="truncate">Next Lesson</span>
                    </div>
                    {#if nextLessonItem}
                      <span class="text-[10px] text-stone-400 dark:text-stone-500 font-mono ml-2 shrink-0">{nextLessonItem.id}</span>
                    {/if}
                  </button>
                </div>

                <div class="py-1">
                  <button
                    type="button"
                    role="menuitem"
                    onclick={() => {
                      isLessonActionsOpen = false;
                      uploadModalMode = 'add';
                      isUploadModalOpen = true;
                    }}
                    class="flex w-full items-center space-x-2 px-3 py-2 text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer text-left"
                    title="Add new chapters / lessons to this course"
                  >
                    <Plus class="w-3.5 h-3.5 text-stone-500 dark:text-stone-400 shrink-0" />
                    <span>Add Chapters</span>
                  </button>

                  <button
                    type="button"
                    role="menuitem"
                    onclick={() => {
                      isLessonActionsOpen = false;
                      uploadModalMode = 'replace';
                      isUploadModalOpen = true;
                    }}
                    class="flex w-full items-center space-x-2 px-3 py-2 text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer text-left"
                    title="Replace current chapter ({currentLessonTitle || selectedLessonId}) with a new file upload"
                  >
                    <RefreshCw class="w-3.5 h-3.5 text-stone-500 dark:text-stone-400 shrink-0" />
                    <span>Replace Lesson</span>
                  </button>
                </div>

                <div class="py-1">
                  <button
                    type="button"
                    role="menuitem"
                    onclick={() => {
                      isLessonActionsOpen = false;
                      queueAllMissing();
                    }}
                    disabled={isQueueingMissing}
                    class="flex w-full items-center space-x-2 px-3 py-2 text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer text-left disabled:opacity-50"
                    title="Scan course and queue all ungenerated study sheets (Summary, Notes, Test) in background"
                  >
                    {#if isQueueingMissing}
                      <Loader2 class="w-3.5 h-3.5 text-amber-500 animate-spin shrink-0" />
                      <span>Queueing...</span>
                    {:else}
                      <Sparkles class="w-3.5 h-3.5 text-amber-500 shrink-0" />
                      <span>Generate Missing</span>
                    {/if}
                  </button>
                </div>
              </div>
            {/if}
          </div>

          <!-- Pop Quiz button to the RIGHT of [...] (Grey thumbs-up if lesson done in schedule, Green checkmark if pending) -->
          <button
            type="button"
            onclick={startPopQuiz}
            class="w-8 h-8 rounded-lg flex items-center justify-center transition cursor-pointer shrink-0 {
              isCurrentLessonDoneInSchedule
                ? 'bg-stone-200 hover:bg-stone-300 active:bg-stone-400 dark:bg-stone-800 dark:hover:bg-stone-700 dark:active:bg-stone-600 text-stone-600 dark:text-stone-300 border border-stone-300 dark:border-stone-700 shadow-2xs'
                : 'bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white shadow-sm hover:shadow'
            }"
            title={isCurrentLessonDoneInSchedule ? 'Lesson marked done in schedule (Click to retake pop quiz)' : 'Take Pop Quiz (5-minute accountability test)'}
            aria-label={isCurrentLessonDoneInSchedule ? 'Retake Pop Quiz' : 'Start Pop Quiz'}
          >
            {#if isCurrentLessonDoneInSchedule}
              <ThumbsUp class="w-4 h-4 stroke-[2.2]" />
            {:else}
              <Check class="w-4 h-4 stroke-[3]" />
            {/if}
          </button>
        {/if}
      </div>

      <!-- Right: Study Tabs (Desktop >= 480px) & Tab Dropdown (Mobile < 480px) -->
      <div class="flex items-center space-x-1.5 sm:space-x-2 shrink min-w-0 ml-auto justify-end">
        <!-- Desktop / Tablet (>= 480px) -->
        <div class="hidden xs:block max-w-full overflow-x-auto scrollbar-none py-0.5">
        <div class="inline-flex rounded-lg border border-stone-200 dark:border-stone-800 p-0.5 bg-stone-100 dark:bg-stone-800/70 text-xs font-medium shrink-0">
        {#if isCourseScope}
          {#if course?.coursePDF}
            <button
              type="button"
              onclick={() => switchTab('book')}
              class="flex items-center space-x-1.5 px-3 py-1 rounded-md transition cursor-pointer {activeTab === 'book' ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-2xs font-semibold' : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200'}"
              title="Accompanying Course Book (PDF)"
            >
              <Book class="w-3.5 h-3.5 text-amber-500" />
              <span>Book</span>
            </button>
          {/if}

          <button
            type="button"
            onclick={() => switchTab('test')}
            class="flex items-center space-x-1.5 px-3 py-1 rounded-md transition cursor-pointer {activeTab === 'test' ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-2xs font-semibold' : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200'}"
          >
            <CheckCircle2 class="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
            <span>Course Practice Test</span>
          </button>

          <button
            type="button"
            onclick={() => switchTab('logs')}
            class="flex items-center space-x-1.5 px-3 py-1 rounded-md transition cursor-pointer {activeTab === 'logs' ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-2xs font-semibold' : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200'}"
          >
            <ScrollText class="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
            <span>Logs</span>
          </button>
        {:else if isUnitScope}
          <button
            onclick={() => switchTab('assignments')}
            class="flex items-center space-x-1.5 px-3 py-1 rounded-md transition {activeTab === 'assignments' ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-2xs font-semibold' : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200'}"
          >
            <Bookmark class="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
            <span>Assignments</span>
          </button>

          <button
            onclick={() => switchTab('test')}
            class="flex items-center space-x-1.5 px-3 py-1 rounded-md transition {activeTab === 'test' ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-2xs font-semibold' : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200'}"
          >
            <CheckCircle2 class="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
            <span>Unit Test</span>
          </button>

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
                title="Delete {customTabDisplayName(slug)} tab for this unit"
              >
                <X class="w-2 h-2" />
              </button>
            </div>
          {/each}

          <button
            onclick={openNewTabModal}
            class="flex items-center justify-center w-7 py-1 rounded-md text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200 hover:bg-stone-200/60 dark:hover:bg-stone-700/60 transition cursor-pointer"
            title="Create a new tab for this unit"
          >
            <Plus class="w-3.5 h-3.5" />
          </button>
        {:else}
          <button
            onclick={() => switchTab('lesson')}
            class="flex items-center space-x-1.5 px-3 py-1 rounded-md transition cursor-pointer {activeTab === 'lesson' ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-2xs font-semibold' : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200'}"
          >
            <BookOpen class="w-3.5 h-3.5" />
            <span>Lesson</span>
          </button>

          {#if course?.coursePDF}
            <button
              onclick={() => switchTab('book')}
              class="flex items-center space-x-1.5 px-3 py-1 rounded-md transition cursor-pointer {activeTab === 'book' ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-2xs font-semibold' : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200'}"
              title="Course Book (PDF)"
            >
              <Book class="w-3.5 h-3.5 text-amber-500" />
              <span>Book</span>
              {#if currentLessonItem?.pageRange}
                <span class="text-3xs px-1.5 py-0.2 rounded bg-amber-100 dark:bg-amber-950/80 text-amber-700 dark:text-amber-300 font-mono">
                  p.{currentLessonItem.pageRange}
                </span>
              {/if}
            </button>
          {/if}

          {#if hasSummaryTab || activeTab === 'summary'}
            <div class="relative group/tab">
              <button
                onclick={() => switchTab('summary')}
                class="flex items-center space-x-1.5 px-3 py-1 rounded-md transition cursor-pointer {activeTab === 'summary' ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-2xs font-semibold' : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200'}"
              >
                <Sparkles class="w-3.5 h-3.5 text-amber-500" />
                <span>Summary</span>
              </button>
              <button
                onclick={() => handleDeleteCustomTab('summary')}
                class="absolute -top-1 -right-1 hidden group-hover/tab:flex items-center justify-center w-3.5 h-3.5 rounded-full bg-stone-300 dark:bg-stone-600 text-stone-700 dark:text-stone-200 hover:bg-red-400 dark:hover:bg-red-500 hover:text-white transition cursor-pointer"
                title="Delete Summary tab for this lesson"
              >
                <X class="w-2 h-2" />
              </button>
            </div>
          {/if}

          <button
            onclick={() => switchTab('notes')}
            class="flex items-center space-x-1.5 px-3 py-1 rounded-md transition {activeTab === 'notes' ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-2xs font-semibold' : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200'}"
          >
            <UserPen class="w-3.5 h-3.5" />
            <span><i>My</i>Work</span>
          </button>

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
        </div>
      </div>

      <!-- Mobile Compact Tab Dropdown (< 480px) -->
      <div class="block xs:hidden relative shrink-0 {isMobileTabDropdownOpen ? 'z-50' : ''}">
        <button
          type="button"
          onclick={() => (isMobileTabDropdownOpen = !isMobileTabDropdownOpen)}
          class="flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg border border-stone-200 dark:border-stone-800 bg-stone-100 dark:bg-stone-800/80 hover:bg-stone-200/60 dark:hover:bg-stone-700/60 text-xs font-medium text-stone-800 dark:text-stone-200 transition shadow-2xs shrink-0 cursor-pointer {isMobileTabDropdownOpen ? 'ring-2 ring-stone-400/20 dark:ring-stone-600/30' : ''}"
          title="Switch tab ({activeTabLabel})"
          aria-expanded={isMobileTabDropdownOpen}
        >
          {#if activeTab === 'lesson'}
            <BookOpen class="w-3.5 h-3.5 shrink-0 text-stone-600 dark:text-stone-300" />
          {:else if activeTab === 'book'}
            <Book class="w-3.5 h-3.5 shrink-0 text-amber-500" />
          {:else if activeTab === 'summary'}
            <Sparkles class="w-3.5 h-3.5 shrink-0 text-amber-500" />
          {:else if activeTab === 'notes' || activeTab === 'studysheet'}
            <UserPen class="w-3.5 h-3.5 shrink-0 text-blue-500" />
          {:else if activeTab === 'schedule'}
            <CalendarDays class="w-3.5 h-3.5 shrink-0 text-stone-600 dark:text-stone-300" />
          {:else if activeTab === 'assignments'}
            <Bookmark class="w-3.5 h-3.5 text-purple-600 dark:text-purple-400 shrink-0" />
          {:else if activeTab === 'test'}
            <CheckCircle2 class="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
          {:else}
            <FileText class="w-3.5 h-3.5 shrink-0 text-stone-500" />
          {/if}
          {#if activeTab === 'notes' || activeTab === 'studysheet'}
            <span class="truncate max-w-[70px] min-[390px]:max-w-[85px]"><i>My</i>Work</span>
          {:else}
            <span class="truncate max-w-[70px] min-[390px]:max-w-[85px]">{activeTabLabel}</span>
          {/if}
          <ChevronDown class="w-3 h-3 text-stone-400 shrink-0 transition {isMobileTabDropdownOpen ? 'rotate-180' : ''}" />
        </button>

        {#if isMobileTabDropdownOpen}
          <!-- Click outside backdrop -->
          <div
            class="fixed inset-0 z-40"
            onclick={() => (isMobileTabDropdownOpen = false)}
            aria-hidden="true"
          ></div>

          <div
            role="menu"
            tabindex="-1"
            class="absolute right-0 top-full mt-1.5 w-48 rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 shadow-xl z-50 py-1 text-xs divide-y divide-stone-100 dark:divide-stone-800 animate-in fade-in zoom-in-95 duration-100"
          >
            <div class="py-1">
              {#if isCourseScope}
                {#if course?.coursePDF}
                  <button
                    type="button"
                    role="menuitem"
                    onclick={() => switchTab('book')}
                    class="flex w-full items-center justify-between px-3 py-2 text-left transition cursor-pointer {activeTab === 'book' ? 'bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100 font-semibold' : 'text-stone-700 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800/60'}"
                  >
                    <div class="flex items-center space-x-2 truncate">
                      <Book class="w-3.5 h-3.5 text-amber-500 shrink-0" />
                      <span class="truncate">Course Book</span>
                    </div>
                    {#if activeTab === 'book'}
                      <Check class="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                    {/if}
                  </button>
                {/if}

                <button
                  type="button"
                  role="menuitem"
                  onclick={() => switchTab('test')}
                  class="flex w-full items-center justify-between px-3 py-2 text-left transition cursor-pointer {activeTab === 'test' ? 'bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100 font-semibold' : 'text-stone-700 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800/60'}"
                >
                  <div class="flex items-center space-x-2 truncate">
                    <CheckCircle2 class="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                    <span class="truncate">Course Practice Test</span>
                  </div>
                  {#if activeTab === 'test'}
                    <Check class="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                  {/if}
                </button>

                <button
                  type="button"
                  role="menuitem"
                  onclick={() => switchTab('logs')}
                  class="flex w-full items-center justify-between px-3 py-2 text-left transition cursor-pointer {activeTab === 'logs' ? 'bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100 font-semibold' : 'text-stone-700 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800/60'}"
                >
                  <div class="flex items-center space-x-2 truncate">
                    <ScrollText class="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
                    <span class="truncate">Logs</span>
                  </div>
                  {#if activeTab === 'logs'}
                    <Check class="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                  {/if}
                </button>

              {:else if isUnitScope}
                <button
                  type="button"
                  role="menuitem"
                  onclick={() => switchTab('assignments')}
                  class="flex w-full items-center justify-between px-3 py-2 text-left transition cursor-pointer {activeTab === 'assignments' ? 'bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100 font-semibold' : 'text-stone-700 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800/60'}"
                >
                  <div class="flex items-center space-x-2 truncate">
                    <Bookmark class="w-3.5 h-3.5 text-purple-600 dark:text-purple-400 shrink-0" />
                    <span class="truncate">Assignments</span>
                  </div>
                  {#if activeTab === 'assignments'}
                    <Check class="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                  {/if}
                </button>

                <button
                  type="button"
                  role="menuitem"
                  onclick={() => switchTab('test')}
                  class="flex w-full items-center justify-between px-3 py-2 text-left transition cursor-pointer {activeTab === 'test' ? 'bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100 font-semibold' : 'text-stone-700 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800/60'}"
                >
                  <div class="flex items-center space-x-2 truncate">
                    <CheckCircle2 class="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <span class="truncate">Unit Test</span>
                  </div>
                  {#if activeTab === 'test'}
                    <Check class="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                  {/if}
                </button>

                {#each customTabs as slug (slug)}
                  <button
                    type="button"
                    role="menuitem"
                    onclick={() => switchTab(slug)}
                    class="flex w-full items-center justify-between px-3 py-2 text-left transition cursor-pointer {activeTab === slug ? 'bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100 font-semibold' : 'text-stone-700 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800/60'}"
                  >
                    <div class="flex items-center space-x-2 truncate">
                      <FileText class="w-3.5 h-3.5 text-stone-500 shrink-0" />
                      <span class="truncate">{customTabDisplayName(slug)}</span>
                    </div>
                    {#if activeTab === slug}
                      <Check class="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                    {/if}
                  </button>
                {/each}

              {:else}
                <button
                  type="button"
                  role="menuitem"
                  onclick={() => switchTab('lesson')}
                  class="flex w-full items-center justify-between px-3 py-2 text-left transition cursor-pointer {activeTab === 'lesson' ? 'bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100 font-semibold' : 'text-stone-700 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800/60'}"
                >
                  <div class="flex items-center space-x-2 truncate">
                    <BookOpen class="w-3.5 h-3.5 text-stone-500 shrink-0" />
                    <span class="truncate">Lessons</span>
                  </div>
                  {#if activeTab === 'lesson'}
                    <Check class="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                  {/if}
                </button>

                {#if course?.coursePDF}
                  <button
                    type="button"
                    role="menuitem"
                    onclick={() => switchTab('book')}
                    class="flex w-full items-center justify-between px-3 py-2 text-left transition cursor-pointer {activeTab === 'book' ? 'bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100 font-semibold' : 'text-stone-700 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800/60'}"
                  >
                    <div class="flex items-center space-x-2 truncate">
                      <Book class="w-3.5 h-3.5 text-amber-500 shrink-0" />
                      <span class="truncate">Book</span>
                      {#if currentLessonItem?.pageRange}
                        <span class="text-3xs font-mono text-stone-400">p.{currentLessonItem.pageRange}</span>
                      {/if}
                    </div>
                    {#if activeTab === 'book'}
                      <Check class="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                    {/if}
                  </button>
                {/if}

                {#if hasSummaryTab || activeTab === 'summary'}
                  <button
                    type="button"
                    role="menuitem"
                    onclick={() => switchTab('summary')}
                    class="flex w-full items-center justify-between px-3 py-2 text-left transition cursor-pointer {activeTab === 'summary' ? 'bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100 font-semibold' : 'text-stone-700 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800/60'}"
                  >
                    <div class="flex items-center space-x-2 truncate">
                      <Sparkles class="w-3.5 h-3.5 text-stone-500 shrink-0" />
                      <span class="truncate">Summary</span>
                    </div>
                    {#if activeTab === 'summary'}
                      <Check class="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                    {/if}
                  </button>
                {/if}

                <button
                  type="button"
                  role="menuitem"
                  onclick={() => switchTab('notes')}
                  class="flex w-full items-center justify-between px-3 py-2 text-left transition cursor-pointer {activeTab === 'notes' ? 'bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100 font-semibold' : 'text-stone-700 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800/60'}"
                >
                  <div class="flex items-center space-x-2 truncate">
                    <UserPen class="w-3.5 h-3.5 text-stone-500 shrink-0" />
                    <span class="truncate"><i>My</i>Work</span>
                  </div>
                  {#if activeTab === 'notes'}
                    <Check class="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                  {/if}
                </button>

                {#each customTabs as slug (slug)}
                  <button
                    type="button"
                    role="menuitem"
                    onclick={() => switchTab(slug)}
                    class="flex w-full items-center justify-between px-3 py-2 text-left transition cursor-pointer {activeTab === slug ? 'bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100 font-semibold' : 'text-stone-700 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800/60'}"
                  >
                    <div class="flex items-center space-x-2 truncate">
                      <FileText class="w-3.5 h-3.5 text-stone-500 shrink-0" />
                      <span class="truncate">{customTabDisplayName(slug)}</span>
                    </div>
                    {#if activeTab === slug}
                      <Check class="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                    {/if}
                  </button>
                {/each}
              {/if}
            </div>

            {#if !isCourseScope}
              <div class="py-1">
                <button
                  type="button"
                  role="menuitem"
                  onclick={() => {
                    isMobileTabDropdownOpen = false;
                    openNewTabModal();
                  }}
                  class="flex w-full items-center space-x-2 px-3 py-2 text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 hover:text-stone-900 dark:hover:text-stone-100 transition cursor-pointer text-left"
                >
                  <Plus class="w-3.5 h-3.5 shrink-0" />
                  <span>New Tab...</span>
                </button>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>

    <!-- Main Workspace Content Area (with checkpoints support). -->
    <div class="relative z-10 flex-1 flex flex-col overflow-hidden w-full max-w-full min-w-0">
      <!-- Full-viewport PDF Book View: kept mounted per course so PDFium engine, blobs & scroll position stay hot -->
      {#if hasLoadedBookOnce}
        <div
          class="relative flex-1 w-full h-full min-h-0 overflow-hidden flex flex-col"
          class:hidden={activeTab !== 'book'}
        >
          <PDFViewer
            url={`/api/courses/${course.id}/assets/locker_docs/course.pdf`}
            courseId={course.id}
            title={`${course.title} - Book`}
            lessonTitle={isCourseScope ? 'Course Overview' : (currentLessonItem?.title || '')}
            pageRange={isCourseScope ? '' : (currentLessonItem?.pageRange || '')}
            readingDescription={isCourseScope ? 'Accompanying course textbook' : (currentLessonItem?.readingDescription || '')}
            {bookmarkedLessons}
            initialPage={queryTargetPdfPage}
          />
        </div>
      {/if}

      <!-- Markdown Workspace View: hidden when PDF book view is active -->
      <div
        class="relative flex-1 flex flex-col overflow-hidden w-full max-w-full min-w-0"
        class:hidden={activeTab === 'book'}
      >
        <div class="pointer-events-none absolute inset-x-0 top-0 bottom-0 max-w-5xl mx-auto w-full z-30">
          <FloatingCheckpointTrigger
            containerEl={contentScroller}
            disabled={isEditing || activeTab === 'book' || !!activeDocument || isCheckpointModalOpen || aiComposer !== null}
            hasSelection={!!activeSelection}
            externalPosition={externalCursorPosition}
            onTriggerHighlight={handleTriggerHighlight}
            onTriggerNote={handleTriggerNote}
            onTriggerAskAI={handleTriggerAskAI}
          />
        </div>

      <div
        class="relative flex-1 overflow-y-auto overflow-x-hidden p-0 sm:p-8 max-w-5xl mx-auto w-full min-w-0 [overflow-anchor:none]"
        bind:this={contentScroller}
        onscroll={handleContentScroll}
      >
        <!-- In-page Checkpoint Markers for this file -->
        {#if !isEditing}
          {#each currentFileNotes as note (note.id)}
            <CheckpointMarker
              checkpoint={note}
              resolvedTop={(() => {
                if (note.anchor?.type === 'element-id' && note.anchor.elementId && htmlAnchorPositions[note.anchor.elementId] !== undefined) {
                  return htmlAnchorPositions[note.anchor.elementId];
                }
                if (note.anchor?.type === 'paragraph' && note.anchor.paragraphIndex !== undefined) {
                  const container = contentScroller?.querySelector('.markdown-body');
                  if (container instanceof HTMLElement) {
                    return resolveMarkdownAnchorPixel(note, container, contentScroller);
                  }
                }
                return undefined;
              })()}
              isOpen={openNoteIds.has(note.id)}
              isActive={activeCheckpoint?.id === note.id && isCheckpointModalOpen}
              onToggle={handleToggleCheckpoint}
              onClose={handleCloseCheckpoint}
              onEdit={handleEditCheckpoint}
              onDelete={handleDeleteCheckpoint}
              onRetryAi={handleRetryCheckpointAi}
            />
          {/each}
        {/if}

        {#if isCourseScope ? isLoadingCourseDoc : isLoadingLesson}
        <div class="h-64 flex items-center justify-center">
          <Loader2 class="w-6 h-6 animate-spin text-stone-300" />
        </div>
      {:else}
        <!-- Top-Right Action Controls (Sticky): direct child of the scroll
             container. Negative top offsets cancel the container's py padding on desktop
             while staying flush on mobile. -->
        <div
          data-markdown-floating-bar
          class="sticky top-1 sm:-top-[30px] z-20 flex justify-end px-2 sm:px-12 pt-0.5 mt-1 mb-2 sm:-mb-[30px] pointer-events-none max-w-full"
        >
          <div class="pointer-events-auto flex items-center space-x-1.5 sm:space-x-2 max-w-full">
            {#if isEditing}
              {#if pageCharCount > 0}
                <span
                  class="text-[10px] sm:text-[11px] font-mono text-stone-400 dark:text-stone-500 select-none mr-0.5 sm:mr-1 whitespace-nowrap leading-none"
                  title="Document length: {pageCharCount.toLocaleString()} characters"
                >
                  {pageCharCount}-chars
                </span>
              {/if}

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
              {#if isCourseScope && activeTab === 'schedule' && tabContents.schedule.trim().length > 0}
                <button
                  type="button"
                  onclick={() => { isSyncModalOpen = true; }}
                  class="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border border-stone-200/90 dark:border-stone-700 bg-white/95 dark:bg-stone-900/95 backdrop-blur-sm hover:bg-white dark:hover:bg-stone-800 text-xs font-medium text-stone-700 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 shadow-xs hover:shadow-sm transition cursor-pointer"
                  title="Synchronize study schedule with Google Calendar or external apps"
                >
                  <CalendarSync class="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                  <span>Sync</span>
                </button>

                <button
                  type="button"
                  onclick={handleScheduleRebuild}
                  disabled={isScheduleGenerating}
                  class="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border border-stone-200/90 dark:border-stone-700 bg-white/95 dark:bg-stone-900/95 backdrop-blur-sm hover:bg-white dark:hover:bg-stone-800 text-xs font-medium text-stone-700 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 shadow-xs hover:shadow-sm transition cursor-pointer disabled:opacity-50"
                  title="Re-schedule with preferences"
                >
                  {#if isScheduleGenerating}
                    <Loader2 class="w-3.5 h-3.5 animate-spin text-amber-500" />
                    <span>Re-Scheduling...</span>
                  {:else}
                    <RotateCcw class="w-3.5 h-3.5 text-stone-500 dark:text-stone-400" />
                    <span>Re-Schedule</span>
                  {/if}
                </button>
              {/if}

              {#if pageCharCount > 0}
                <span
                  class="text-[10px] sm:text-[11px] font-mono text-stone-400 dark:text-stone-500 select-none mr-0.5 sm:mr-1 whitespace-nowrap leading-none"
                  title="Document length: {pageCharCount.toLocaleString()} characters"
                >
                  {pageCharCount}-chars
                </span>
              {/if}

              {#if activeTab !== 'test' && activeTab !== 'book' && course?.id}
                <MarkupMenu courseId={course.id} file={currentFile} />
              {/if}

              <!-- More actions menu ([...]): Edit, Prompt, PDF -->
              {#if activeTab !== 'book'}
              <div class="relative inline-flex items-center">
                <button
                  type="button"
                  onclick={() => (isActionMenuOpen = !isActionMenuOpen)}
                  class="relative flex items-center justify-center px-2 py-1.5 rounded-lg border backdrop-blur-sm text-xs font-medium transition shadow-xs hover:shadow-sm cursor-pointer {isActionMenuOpen
                    ? 'border-stone-400 dark:border-stone-600 bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100'
                    : 'border-stone-200/90 dark:border-stone-700 bg-white/95 dark:bg-stone-900/95 hover:bg-white dark:hover:bg-stone-800 text-stone-700 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100'}"
                  title="More actions (Prompt, PDF, Edit)"
                  aria-haspopup="menu"
                  aria-expanded={isActionMenuOpen}
                >
                  <MoreVertical class="w-4 h-4" />
                  {#if showPromptCard}
                    <span class="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-indigo-500 border-2 border-white dark:border-stone-900" title="Prompt card open"></span>
                  {/if}
                </button>

                {#if isActionMenuOpen}
                  <!-- Click outside backdrop -->
                  <div
                    class="fixed inset-0 z-40"
                    onclick={() => (isActionMenuOpen = false)}
                    aria-hidden="true"
                  ></div>

                  <div
                    role="menu"
                    tabindex="-1"
                    class="absolute right-0 top-full mt-1.5 w-44 rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 shadow-xl z-50 py-1 text-xs divide-y divide-stone-100 dark:divide-stone-800 animate-in fade-in zoom-in-95 duration-100"
                  >
                    <div class="py-1">
                      <!-- Edit -->
                      <button
                        type="button"
                        role="menuitem"
                        onclick={() => {
                          isActionMenuOpen = false;
                          isEditing = true;
                        }}
                        class="flex w-full items-center space-x-2 px-3 py-2 text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer text-left font-medium"
                        title="Edit content"
                      >
                        <Edit3 class="w-3.5 h-3.5 text-stone-500 dark:text-stone-400 shrink-0" />
                        <span>Edit</span>
                      </button>

                      <!-- View Mode Toggle (for non-markdown lesson tabs) -->
                      {#if activeTab === 'lesson' && !isCourseScope && !isUnitScope && effectiveFormat !== 'markdown'}
                        <button
                          type="button"
                          role="menuitem"
                          onclick={() => {
                            isActionMenuOpen = false;
                            toggleLessonViewMode();
                          }}
                          class="flex w-full items-center space-x-2 px-3 py-2 text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer text-left font-medium"
                          title="Toggle between original presentation and markdown"
                        >
                          {#if lessonViewMode === 'original'}
                            <FileText class="w-3.5 h-3.5 text-stone-500 dark:text-stone-400 shrink-0" />
                            <span>View as Markdown</span>
                          {:else}
                            <Eye class="w-3.5 h-3.5 text-stone-500 dark:text-stone-400 shrink-0" />
                            <span>View Original {effectiveFormat === 'html' ? 'HTML' : 'PDF'}</span>
                          {/if}
                        </button>
                      {/if}

                      <!-- Prompt -->
                      {#if activeTab !== 'lesson' && activeTab !== 'schedule' && activeTab !== 'logs'}
                        <button
                          type="button"
                          role="menuitem"
                          onclick={() => {
                            isActionMenuOpen = false;
                            togglePromptCard();
                          }}
                          class="flex w-full items-center justify-between px-3 py-2 text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer text-left font-medium {showPromptCard ? 'text-indigo-600 dark:text-indigo-400 font-semibold' : ''}"
                          title={showPromptCard ? 'Hide prompt card' : 'Tweak AI prompt'}
                        >
                          <div class="flex items-center space-x-2">
                            <Sparkles class="w-3.5 h-3.5 {showPromptCard ? 'text-indigo-600 dark:text-indigo-400' : 'text-stone-500 dark:text-stone-400'} shrink-0" />
                            <span>Prompt</span>
                          </div>
                          {#if showPromptCard}
                            <span class="text-[10px] text-indigo-600 dark:text-indigo-400 font-semibold">Active</span>
                          {/if}
                        </button>
                      {/if}

                      <!-- PDF -->
                      <button
                        type="button"
                        role="menuitem"
                        onclick={() => {
                          isActionMenuOpen = false;
                          handleExportPDF();
                        }}
                        disabled={isExportingPdf}
                        class="flex w-full items-center space-x-2 px-3 py-2 text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50 transition cursor-pointer text-left font-medium"
                        title="Generate and download PDF for this document"
                      >
                        {#if isExportingPdf}
                          <Loader2 class="w-3.5 h-3.5 animate-spin text-stone-500 dark:text-stone-400 shrink-0" />
                          <span>Exporting PDF...</span>
                        {:else}
                          <FileDown class="w-3.5 h-3.5 text-stone-500 dark:text-stone-400 shrink-0" />
                          <span>Export PDF</span>
                        {/if}
                      </button>
                    </div>
                  </div>
                {/if}
              </div>
              {/if}
            {/if}
          </div>
        </div>

        <!-- Prompt Card for generated tabs (when revealed and not editing raw markdown) -->
        {#if showPromptCard && activeTab !== 'lesson' && activeTab !== 'book' && activeTab !== 'schedule' && activeTab !== 'logs' && !isEditing}
          <div class="pt-6 sm:pt-10 px-1.5 sm:px-0 mb-2 sm:mb-4">
            <PromptCard
              prompt={parsedActiveTab.frontmatter.prompt || defaultPromptForActiveTab}
              defaultPrompt={defaultPromptForActiveTab}
              tabName={isCourseScope ? `Course ${tabDisplayName}` : tabDisplayName}
              isGenerating={isCourseScope ? (activeTab === 'schedule' ? isScheduleGenerating : isGeneratingCourseDoc) : isTabGenerating}
              courseId={courseId}
              lessonId={isCourseScope ? undefined : selectedLessonId}
              activeTab={activeTab}
              initialAttachment={parsedActiveTab.frontmatter.contextAttachment}
              onChangePrompt={handlePromptChange}
              onRegenerate={(opts) => {
                if (isCourseScope) {
                  if (activeTab === 'schedule') {
                    isScheduleModalOpen = true;
                  } else {
                    generateCourseDocument(activeTab, opts);
                  }
                } else {
                  triggerAIGeneration(opts);
                }
              }}
              onResetPrompt={() => handlePromptChange(defaultPromptForActiveTab)}
              onClose={() => (showPromptCard = false)}
            />
          </div>
        {/if}

        <!-- Main Card: responsive layout (edge-to-edge on mobile, rounded card on tablet/desktop) -->
        <div class="relative bg-white dark:bg-stone-900 rounded-none sm:rounded-2xl border-0 sm:border border-stone-200 dark:border-stone-800 shadow-none sm:shadow-2xs group w-full max-w-full min-w-0 overflow-hidden">
          {#if isCourseScope && isGeneratingCourseDoc && activeTab !== 'schedule'}
            <div class="h-64 flex flex-col items-center justify-center space-y-3 p-8 text-center">
              <Loader2 class="w-7 h-7 animate-spin text-amber-500" />
              <div class="text-sm font-medium text-stone-800 dark:text-stone-200">
                Generating Course {tabDisplayName}...
              </div>
              <p class="text-xs text-stone-500 dark:text-stone-400 max-w-sm">
                {activeTab === 'test'
                  ? 'Generating comprehensive practice test across all units with AI. This may take 30–60 seconds.'
                  : `Synthesizing lesson ${activeTab}s across all units with AI. This may take 15–30 seconds.`}
              </p>
            </div>
          {:else if isEditing}
            <!-- CodeMirror Editor (markdown body only; frontmatter preserved and re-appended) -->
            <div class="px-[6px] py-3 pt-12 sm:p-6 sm:pt-16 w-full max-w-full min-w-0 overflow-hidden">
              <div class="h-[calc(100vh-16rem)] w-full max-w-full min-w-0">
                <CodeMirrorEditor
                  value={tabContents[activeTab]}
                  courseId={course.id}
                  lessonId={isCourseScope ? 'course' : selectedLessonId}
                  onChange={handleEditorChange}
                  onSave={handleSaveEdit}
                />
              </div>
            </div>
          {:else if (isUnitScope || isCourseScope) && activeTab === 'test'}
            <!-- Practice Test Interactive View -->
            <div class="px-[6px] py-4 sm:p-10 w-full max-w-full min-w-0 overflow-x-auto">
              {#if !parsedActiveTab.body || parsedActiveTab.body.trim().length === 0}
                <div class="max-w-md mx-auto py-12 text-center space-y-3">
                  <div class="mx-auto w-fit p-3 rounded-2xl bg-stone-100 dark:bg-stone-800 text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 class="w-6 h-6" />
                  </div>
                  <h3 class="text-base font-semibold text-stone-900 dark:text-stone-100">
                    {isCourseScope ? 'Course Practice Test' : 'Unit Practice Test'}
                  </h3>
                  <p class="text-xs text-stone-500 dark:text-stone-400 leading-relaxed">
                    {isCourseScope
                      ? 'This course practice test has not been generated yet. Click "Prompt" above to generate a comprehensive practice test covering all units.'
                      : 'This unit practice test has not been generated yet. Click "Prompt" above to generate a comprehensive practice test covering all lessons in this unit.'}
                  </p>
                </div>
              {:else}
                {#key `${quizRunnerKey}-${parsedActiveTab.body}`}
                  <QuizRunner
                    testMarkdown={parsedActiveTab.body}
                    isUnitTest={isUnitScope}
                    lastAttemptDate={parsedActiveTab.frontmatter.lastAttemptDate}
                    lastScore={typeof parsedActiveTab.frontmatter.score === 'number' ? parsedActiveTab.frontmatter.score : undefined}
                    lastTotal={typeof parsedActiveTab.frontmatter.totalQuestions === 'number' ? parsedActiveTab.frontmatter.totalQuestions : undefined}
                    lastPercentage={typeof parsedActiveTab.frontmatter.percentage === 'number' ? parsedActiveTab.frontmatter.percentage : undefined}
                    supervisorMessage={unitTestSupervisorMessage}
                    onSubmitUnitTest={handleSubmitUnitTest}
                  />
                {/key}
              {/if}
            </div>
          {:else}
            <!-- Reader View -->
            {#if activeTab === 'lesson' && !isCourseScope && !isUnitScope && effectiveFormat !== 'markdown' && lessonViewMode === 'original'}
              <article class="px-[6px] py-4 sm:p-6 w-full max-w-full min-w-0 overflow-hidden">
                {#if effectiveFormat === 'html'}
                  <HtmlViewer
                    courseId={course.id}
                    lessonId={selectedLessonId}
                    title={currentLessonItem?.title || 'Lesson'}
                    scrollerEl={contentScroller}
                    checkpoints={currentFileNotes}
                    onOpenDocument={handleOpenDocument}
                    onNavigateLesson={handleNavigateFromLesson}
                    onMouseMove={(coords) => {
                      externalCursorPosition = coords;
                    }}
                    onMouseLeave={() => {
                      externalCursorPosition = null;
                    }}
                    onTextSelected={(sel) => {
                      activeSelection = sel;
                    }}
                    onSelectionCleared={() => {
                      activeSelection = null;
                    }}
                    onResolveAnchors={(positions) => {
                      htmlAnchorPositions = { ...htmlAnchorPositions, ...positions };
                    }}
                  />
                {:else if effectiveFormat === 'pdf'}
                  <iframe
                    src="{getApiBaseUrl()}/api/courses/{encodeURIComponent(course.id)}/{encodeURIComponent(selectedLessonId)}/content"
                    title={currentLessonItem?.title ?? 'PDF Lesson'}
                    class="w-full rounded-xl border border-stone-200 dark:border-stone-800 bg-white"
                    style="height: 80vh;"
                  ></iframe>
                {/if}
              </article>
            {:else}
              <!-- Markdown Reader View -->
              <article class="px-[6px] py-4 sm:p-10 w-full max-w-full min-w-0 overflow-hidden">
                <MarkdownViewer
                  markdown={parsedActiveTab.body}
                  courseId={course.id}
                  onDeleteNote={handleDeleteNote}
                  onOpenDocument={handleOpenDocument}
                  markupFile={currentFile}
                  markupScroller={contentScroller}
                  checkpoints={currentFileNotes}
                  onAnnotationSelect={(params) => {
                    activeSelection = {
                      text: params.text,
                      anchor: params.anchor,
                      selection: params.selection,
                      verticalPosition: params.verticalPosition ?? params.anchor.verticalPosition
                    };
                  }}
                  onSelectionCleared={() => {
                    activeSelection = null;
                  }}
                />
                {#if markupUi.mode}
                  <div class="relative z-10 flex justify-center pt-2 pb-1">
                    <button
                      bind:this={extendBtnEl}
                      type="button"
                      onpointerdown={(e) => e.stopPropagation()}
                      onclick={handleExtendPage}
                      disabled={isExtendingPage}
                      class="group inline-flex items-center space-x-1.5 px-3.5 py-1.5 rounded-xl border border-stone-200 dark:border-stone-700 bg-white/95 dark:bg-stone-800/95 backdrop-blur-xs text-stone-700 dark:text-stone-200 hover:text-stone-900 dark:hover:text-stone-100 hover:bg-stone-50 dark:hover:bg-stone-700/80 shadow-xs hover:shadow-sm transition cursor-pointer select-none active:scale-95 disabled:opacity-50"
                      title="Add Sketch"
                      aria-label="Add Sketch"
                    >
                      <StickyNotePlus class="w-3.5 h-3.5 text-amber-500 shrink-0" />
                      <span class="text-xs font-medium">Add Sketch</span>
                    </button>
                  </div>
                {/if}
              </article>
            {/if}
          {/if}
        </div>
      {/if}
    </div>
    </div>
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
    promptTemplate={
      (activeTab === 'schedule' && isCourseScope && parsedActiveTab.frontmatter.prompt) ||
      genericPrompts['course_schedule'] ||
      ''
    }
    defaultPromptTemplate={genericPrompts['course_schedule'] || defaultPromptForActiveTab || ''}
    courseTitle={course?.title}
    lessonCount={course ? (course.units || []).flatMap((u) => u.lessons).length : 0}
    course={course}
  />

  <!-- New custom tab modal -->
  {#if isNewTabModalOpen}
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/40 dark:bg-black/60 backdrop-blur-xs animate-in fade-in duration-150">
      <!-- Backdrop dismiss -->
      <button
        type="button"
        class="absolute inset-0 w-full h-full cursor-default"
        onclick={() => (isNewTabModalOpen = false)}
        aria-label="Close modal overlay"
        tabindex="-1"
      ></button>

      <div class="relative z-10 bg-white dark:bg-stone-900 rounded-xl border border-stone-200 dark:border-stone-800 shadow-xl max-w-sm w-full p-5 space-y-4">
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

  <CheckpointModal
    isOpen={isCheckpointModalOpen}
    checkpoint={activeCheckpoint}
    onSave={handleSaveCheckpoint}
    onDelete={handleDeleteCheckpoint}
    onClose={() => {
      isCheckpointModalOpen = false;
    }}
  />

  <AskAiComposer
    isOpen={aiComposer !== null}
    quote={aiComposer?.quote || ''}
    contextLabel={currentLessonTitle || selectedLessonId || ''}
    onSubmit={handleAskAiSubmit}
    onClose={() => {
      aiComposer = null;
    }}
  />

  {#if checkpointErrorMessage}
    <div
      class="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 max-w-md px-4 py-2.5 rounded-xl bg-red-600/95 text-white text-xs font-medium shadow-lg flex items-center gap-2"
      role="alert"
    >
      <span>{checkpointErrorMessage}</span>
      <button
        type="button"
        class="ml-1 p-1 rounded-lg hover:bg-red-500 transition cursor-pointer"
        onclick={() => (checkpointErrorMessage = '')}
        aria-label="Dismiss"
      >
        <X class="w-3.5 h-3.5" />
      </button>
    </div>
  {/if}

  <SyncScheduleModal
    isOpen={isSyncModalOpen}
    onClose={() => {
      isSyncModalOpen = false;
    }}
    courseId={courseId || ''}
    courseTitle={course?.title}
  />
{/if}

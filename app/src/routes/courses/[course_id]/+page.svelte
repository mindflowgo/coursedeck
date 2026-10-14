<script lang="ts">
  import { apiFetch } from '$lib/api';
  import { queueStatus } from '$lib/queueStatus.svelte';
  import { page } from '$app/stores';
  import Header from '$lib/components/Header.svelte';
  import LessonSelector from '$lib/components/LessonSelector.svelte';
  import MarkdownViewer from '$lib/components/MarkdownViewer.svelte';
  import CodeMirrorEditor from '$lib/components/CodeMirrorEditor.svelte';
  import QuizRunner from '$lib/components/QuizRunner.svelte';
  import UploadModal from '$lib/components/UploadModal.svelte';
  import PromptCard, { type VersionItem } from '$lib/components/PromptCard.svelte';
  import ConfigureLLMModal from '$lib/components/ConfigureLLMModal.svelte';
  import SchedulePreferencesModal from '$lib/components/SchedulePreferencesModal.svelte';
  import ScheduleViewer from '$lib/components/ScheduleViewer.svelte';
  import SelectionToolbar from '$lib/components/SelectionToolbar.svelte';
  import DocumentViewerModal from '$lib/components/DocumentViewerModal.svelte';
  import { parseFrontmatter, serializeWithFrontmatter } from '$lib/parser/frontmatter';
  import { validateScheduleMarkdown } from '$lib/parser/scheduleValidation';
  import { ScheduleParser } from '$lib/parser/scheduleParser';
  import { formatUserNote, insertAnnotationAfterText, removeAnnotation } from '$lib/parser/annotationInserter';
  import type { CourseManifest } from '$lib/parser/courseIngest';
  import type { LessonContentBundle, LessonFileVersion } from '$lib/server/courses';
  import { onMount, onDestroy } from 'svelte';
  import {
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

  let courseId = $derived($page.params.course_id);
  let course: CourseManifest | null = $state(null);
  let selectedLessonId: string = $state('');
  type PageTab = 'lesson' | 'summary' | 'cheatsheet' | 'test' | 'schedule';
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

  // Active version IDs for versioned tabs
  let activeVersions: Record<'summary' | 'cheatsheet' | 'test', string> = $state({
    summary: 'summary',
    cheatsheet: 'cheatsheet',
    test: 'test'
  });

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
    return isCourseScope ? 'Course Notes' : 'Notes';
  });

  // Current list of versions for active tab
  let currentTabVersions = $derived.by((): VersionItem[] => {
    if (isCourseScope || !lessonBundle || activeTab === 'lesson') return [];
    if (activeTab === 'summary') return lessonBundle.summaries;
    if (activeTab === 'cheatsheet') return lessonBundle.cheatsheets;
    if (activeTab === 'test') return lessonBundle.tests;
    return [];
  });

  let activeVersionId = $derived.by(() => {
    if (isCourseScope) return activeTab;
    if (activeTab === 'lesson' || activeTab === 'schedule') return 'lesson';
    return activeVersions[activeTab] || currentTabVersions[0]?.id || activeTab;
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

  async function loadCourse(selectTargetLessonId?: string) {
    isLoadingCourse = true;
    try {
      const res = await apiFetch(`/api/courses/${courseId}`);
      if (res.ok) {
        const data = await res.json();
        course = data.course;
        if (!isCourseScope && course && course.units.length > 0 && course.units[0].lessons.length > 0) {
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
    try {
      if (tab === 'lesson') {
        const res = await apiFetch(`/api/courses/${courseId}/course-docs?type=notes`);
        if (res.ok) {
          const data = await res.json();
          tabContents.lesson = data.markdown || '';
          originalContents.lesson = tabContents.lesson;
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
          } else {
            // Not yet generated: auto-trigger generation
            isLoadingCourseDoc = false;
            await generateCourseDocument(tab);
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

  async function enqueueScheduleGeneration(promptWithPreferences: string) {
    const localConfig = getLocalLLMConfig();
    if (!localConfig?.baseUrl) {
      isLLMModalOpen = true;
      return;
    }

    if (!promptWithPreferences || promptWithPreferences.trim().length === 0) {
      alert(
        'Core prompt template for course schedule is missing. Please add course_schedule.md in Prompts before generating.'
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
      model: localConfig.model || '(server default)',
      provider: localConfig.provider || 'openai_compatible',
      baseUrl: localConfig.baseUrl
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
          customConfig: localConfig
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
    if (type === 'lesson') return;

    const promptKey = `course_${type}`;
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

    const localConfig = getLocalLLMConfig();
    if (!localConfig?.baseUrl) {
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
          customConfig: localConfig,
          timeoutMs: 180_000,
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

        while (true) {
          await new Promise((r) => setTimeout(r, pollInterval));
          if (Date.now() - startTime > maxWaitMs) {
            throw new Error(`Generation timed out after 6 minutes`);
          }

          const pollRes = await apiFetch(`/api/courses/${courseId}/course-docs?type=${type}&status=true`);
          if (!pollRes.ok) {
            const errData = await pollRes.json().catch(() => ({}));
            throw new Error(errData.error || errData.message || `Generation failed (HTTP ${pollRes.status})`);
          }

          const pollData = await pollRes.json();
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
        course.courseDocs[type] = true;
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

  function switchTab(tab: PageTab) {
    activeTab = tab;
    isEditing = false;
    if (isCourseScope) {
      loadCourseDocument(tab);
    }
  }

  function selectLesson(lessonId: string) {
    isCourseScope = false;
    isEditing = false;
    loadLesson(lessonId);
  }

  function selectCourseMode() {
    isCourseScope = true;
    isEditing = false;
    loadCourseDocument(activeTab);
  }

  async function loadLesson(lessonId: string, retainVersionTab?: { tab: 'summary' | 'cheatsheet' | 'test'; versionId: string }) {
    selectedLessonId = lessonId;
    isLoadingLesson = true;
    try {
      const res = await apiFetch(`/api/courses/${courseId}/${lessonId}`);
      if (res.ok) {
        const data: LessonContentBundle = await res.json();
        lessonBundle = data;

        // Set or retain active version IDs
        const summaryVer = retainVersionTab?.tab === 'summary'
          ? retainVersionTab.versionId
          : (data.summaries.find((v) => v.id === activeVersions.summary)?.id || data.summaries[0]?.id || 'summary');

        const cheatsheetVer = retainVersionTab?.tab === 'cheatsheet'
          ? retainVersionTab.versionId
          : (data.cheatsheets.find((v) => v.id === activeVersions.cheatsheet)?.id || data.cheatsheets[0]?.id || 'cheatsheet');

        const testVer = retainVersionTab?.tab === 'test'
          ? retainVersionTab.versionId
          : (data.tests.find((v) => v.id === activeVersions.test)?.id || data.tests[0]?.id || 'test');

        activeVersions = {
          summary: summaryVer,
          cheatsheet: cheatsheetVer,
          test: testVer
        };

        const activeSummaryContent = data.summaries.find((v) => v.id === summaryVer)?.content || data.summary || '';
        const activeCheatsheetContent = data.cheatsheets.find((v) => v.id === cheatsheetVer)?.content || data.cheatsheet || '';
        const activeTestContent = data.tests.find((v) => v.id === testVer)?.content || data.test || '';

        tabContents = {
          lesson: data.lesson || '',
          summary: activeSummaryContent,
          cheatsheet: activeCheatsheetContent,
          test: activeTestContent
        };
        originalContents = { ...tabContents };
      }
    } catch (e) {
      console.error('Failed to load lesson:', e);
    } finally {
      isLoadingLesson = false;
    }
  }

  function handleSelectVersion(versionId: string) {
    if (activeTab === 'lesson' || activeTab === 'schedule' || !lessonBundle) return;
    activeVersions[activeTab] = versionId;

    let versionsList: LessonFileVersion[] = [];
    if (activeTab === 'summary') versionsList = lessonBundle.summaries;
    else if (activeTab === 'cheatsheet') versionsList = lessonBundle.cheatsheets;
    else if (activeTab === 'test') versionsList = lessonBundle.tests;

    const found = versionsList.find((v) => v.id === versionId);
    if (found) {
      tabContents[activeTab] = found.content;
      originalContents[activeTab] = found.content;
    }
  }

  async function handleCreateNewVersion() {
    if (activeTab === 'lesson' || activeTab === 'schedule' || !selectedLessonId) return;

    const nextVer = (currentTabVersions.length > 0 ? Math.max(...currentTabVersions.map((v) => v.versionNumber)) : 0) + 1;
    const defaultPrompt = genericPrompts[activeTab] || '';

    let placeholderBody = `# ${currentLessonTitle} - ${tabDisplayName} (v${nextVer})\n\nClick "Re-generate with AI" above to generate study material using this prompt.`;
    if (activeTab === 'test') {
      placeholderBody = `# ${currentLessonTitle} - Practice Test (v${nextVer})\n\n## Questions\n01) [Knowledge & Understanding] Placeholder question.\n<Multiple-Choice>\n- [ ] Option A\n- [ ] Option B\n\n--\n\n## Answers\n01) A - (explanation) Placeholder answer. Click "Re-generate with AI" to generate curriculum questions.\n`;
    }

    const newContent = serializeWithFrontmatter(
      {
        prompt: defaultPrompt,
        type: activeTab,
        version: nextVer,
        updatedAt: new Date().toISOString().split('T')[0]
      },
      placeholderBody
    );

    try {
      const res = await apiFetch(`/api/courses/${courseId}/${selectedLessonId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tab: activeTab,
          content: newContent,
          asNewVersion: true
        })
      });

      if (res.ok) {
        const result = await res.json();
        await loadLesson(selectedLessonId, { tab: activeTab, versionId: result.versionId });
        saveSuccessMessage = `Created v${nextVer}!`;
        setTimeout(() => {
          saveSuccessMessage = '';
        }, 2000);
      }
    } catch (e) {
      console.error('Failed to create new version:', e);
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

  function handleScheduleGenerate(promptWithPreferences: string) {
    enqueueScheduleGeneration(promptWithPreferences);
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
      const targetTab = activeTab === 'lesson' ? 'lesson' : activeVersions[activeTab];
      const res = await apiFetch(`/api/courses/${courseId}/${selectedLessonId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tab: targetTab,
          content: tabContents[activeTab],
          asNewVersion: false
        })
      });

      if (res.ok) {
        originalContents[activeTab] = tabContents[activeTab];
        saveSuccessMessage = 'Saved!';
        setTimeout(() => {
          saveSuccessMessage = '';
        }, 2000);
        // Silently reload lesson bundle to sync versions
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

  function getLocalLLMConfig() {
    if (typeof localStorage === 'undefined') return undefined;
    localStorage.removeItem('ilc_llm_apiKey');
    const baseUrl = localStorage.getItem('ilc_llm_baseUrl');
    if (!baseUrl) return undefined;
    return {
      provider: localStorage.getItem('ilc_llm_provider') || 'openai_compatible',
      baseUrl,
      authHeaderType: (localStorage.getItem('ilc_llm_authHeaderType') as any) || 'bearer',
      model: (localStorage.getItem('ilc_llm_model') ?? '').trim(),
      temperature: parseFloat(localStorage.getItem('ilc_llm_temp') || '0.3')
    };
  }

  async function triggerAIGeneration(asNewVersion: boolean = false) {
    if (activeTab === 'lesson') return;

    const localConfig = getLocalLLMConfig();
    if (!localConfig?.baseUrl) {
      isLLMModalOpen = true;
      return;
    }

    try {
      const activeSystemPrompt = parsedActiveTab.frontmatter.prompt || defaultPromptForActiveTab;

      console.log(`\n[ILC AI Enqueue: ${tabDisplayName}]`);
      console.log(`- Course: ${(courseId || '').toUpperCase()} | Lesson: ${selectedLessonId} (${currentLessonTitle})`);
      console.log(`- Endpoint: ${localConfig.baseUrl}`);
      console.log(`- Model: ${localConfig.model || '(server default)'}`);
      console.log(`- Mode: ${asNewVersion ? 'Save as new version' : 'Overwrite current'}`);
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
          asNewVersion,
          customPrompt: activeSystemPrompt,
          customConfig: localConfig
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

      saveSuccessMessage = asNewVersion
        ? `✨ Queued new version of ${tabDisplayName}!`
        : `✨ Queued ${tabDisplayName} for generation!`;

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
      const matchTab = (tab: string) => tab.replace(/-\d+$/, '') === activeTab;
      const matches = (t: { courseId: string; tab: string }) =>
        t.courseId === (courseId || '').toLowerCase() && matchTab(t.tab);
      return Boolean(s.activeTask && matches(s.activeTask)) || s.tasks.some((t) => t.status === 'pending' && matches(t));
    }
    const matchTab = (tab: string) => tab.replace(/-\d+$/, '') === activeTab;
    const matches = (t: { courseId: string; lessonId: string; tab: string }) =>
      t.courseId === (courseId || '').toLowerCase() &&
      t.lessonId === selectedLessonId &&
      matchTab(t.tab);
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
    const localConfig = getLocalLLMConfig();
    if (!localConfig?.baseUrl) {
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
          tabs: ['summary', 'cheatsheet', 'test'],
          customConfig: localConfig
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
    let provider = '';
    let baseUrl = '';
    let model = '';
    let authHeaderType: 'bearer' | 'api_key' | 'both' = 'bearer';
    let temperature = 0.3;

    if (typeof localStorage !== 'undefined') {
      provider = localStorage.getItem('ilc_llm_provider') || '';
      baseUrl = localStorage.getItem('ilc_llm_baseUrl') || '';
      model = localStorage.getItem('ilc_llm_model') || '';
      authHeaderType = (localStorage.getItem('ilc_llm_authHeaderType') as any) || 'bearer';
      temperature = parseFloat(localStorage.getItem('ilc_llm_temp') || '0.3');
    }

    if (!baseUrl) {
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
          config: {
            provider,
            baseUrl,
            authHeaderType,
            model,
            temperature,
            sessionId
          },
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
      triggerAIGeneration(false);
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
        const activeVer = currentTabVersions.find((v) => v.id === activeVersionId);
        const exportTabName = activeTab === 'lesson' ? 'Course Notes' : tabDisplayName || activeTab;

        await exportDocumentToPdf({
          courseCode: course.id,
          courseTitle: course.title,
          lessonId: selectedLessonId,
          lessonTitle: currentLessonTitle || selectedLessonId,
          tab: activeTab,
          tabDisplayName: exportTabName,
          version: activeVer?.versionNumber,
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

  onMount(async () => {
    await loadPrompts();

    const urlScope = $page.url.searchParams.get('scope');
    const urlLesson = $page.url.searchParams.get('lesson');
    const urlTab = $page.url.searchParams.get('tab');
    if (urlTab) {
      if (urlTab === 'notes') activeTab = 'lesson';
      else if (['lesson', 'summary', 'cheatsheet', 'test', 'schedule'].includes(urlTab)) {
        activeTab = urlTab as PageTab;
      }
    }
    if (activeTab === 'schedule') {
      // Schedule is course-scoped only.
      isCourseScope = true;
    }

    if (urlScope === 'course') {
      isCourseScope = true;
      await loadCourse();
      await loadCourseDocument(activeTab);
    } else if (urlLesson) {
      await loadCourse();
      // Deep link from a schedule entry: open the lesson, optionally its tab.
      const known = (course?.units || []).some((u) => u.lessons.some((l) => l.id === urlLesson));
      if (known) {
        selectLesson(urlLesson);
      }
    } else {
      await loadCourse();
    }

    startQueueFeedback();
    // Load the PDF engine and fonts while the browser is idle, so the first
    // export doesn't pay the cold-start cost on the click.
    schedulePdfPrewarm();
    if (typeof window !== 'undefined') {
      window.addEventListener('popstate', handlePopState);
    }
  });

  onDestroy(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('popstate', handlePopState);
    }
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
  courseId={course?.id}
  courseTitle={course?.title}
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
    <a href="/" class="text-xs text-stone-900 font-medium underline">Return to courses</a>
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

        {#if isCourseScope}
          <button
            onclick={() => switchTab('schedule')}
            class="flex items-center space-x-1.5 px-3 py-1 rounded-md transition {activeTab === 'schedule' ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-2xs font-semibold' : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200'}"
          >
            <CalendarDays class="w-3.5 h-3.5" />
            <span>Schedule</span>
          </button>
        {/if}
      </div>
    </div>

    <!-- Main Workspace Content Area -->
    <div class="flex-1 overflow-y-auto p-4 sm:p-8 max-w-5xl mx-auto w-full">
      {#if isCourseScope ? isLoadingCourseDoc : isLoadingLesson}
        <div class="h-64 flex items-center justify-center">
          <Loader2 class="w-6 h-6 animate-spin text-stone-300" />
        </div>
      {:else}
        <!-- Prompt Card with Version Switcher for Summary, Cheatsheet, Test (when not editing raw markdown) -->
        {#if activeTab !== 'lesson' && !isEditing}
          <PromptCard
            prompt={parsedActiveTab.frontmatter.prompt || defaultPromptForActiveTab}
            defaultPrompt={defaultPromptForActiveTab}
            tabName={isCourseScope ? `Course ${tabDisplayName}` : tabDisplayName}
            versions={isCourseScope ? [] : currentTabVersions}
            activeVersionId={isCourseScope ? '' : activeVersionId}
            isGenerating={isCourseScope ? (activeTab === 'schedule' ? isScheduleGenerating : isGeneratingCourseDoc) : isTabGenerating}
            onChangePrompt={handlePromptChange}
            onRegenerate={isCourseScope
            ? activeTab === 'schedule'
              ? // Schedule regeneration always starts from the (adjustable) survey.
                () => (isScheduleModalOpen = true)
              : () => generateCourseDocument(activeTab)
            : triggerAIGeneration}
            onSelectVersion={isCourseScope ? undefined : handleSelectVersion}
            onCreateNewVersion={isCourseScope ? undefined : handleCreateNewVersion}
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
    promptTemplate={genericPrompts['course_schedule'] || ''}
    courseTitle={course.title}
  />
{/if}

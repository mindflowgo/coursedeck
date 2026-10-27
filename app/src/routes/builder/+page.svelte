<script lang="ts">
  import Header from '$lib/components/Header.svelte';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { apiFetch } from '$lib/api';
  import { confirmDialog } from '$lib/dialog';
  import {
    BookOpen,
    Sparkles,
    FileArchive,
    Layers,
    Plus,
    Trash2,
    ArrowUp,
    ArrowDown,
    FileText,
    GraduationCap,
    CheckCircle2,
    AlertCircle,
    Loader2,
    ChevronDown,
    ChevronRight,
    Wand2,
    Upload,
    X,
    ListPlus,
    FileCode,
    Check,
    ArrowLeft,
    ArrowRight,
    Pencil,
    MoreVertical,
    RotateCcw
  } from 'lucide-svelte';
  import MarkdownViewer from '$lib/components/MarkdownViewer.svelte';

  // --- Types ---
  interface BuilderLesson {
    id: string;
    title: string;
    type: 'lesson' | 'assignment';
    content: string;
    expanded?: boolean;
    preview?: boolean;
    generatingContent?: boolean;
  }

  interface BuilderUnit {
    number: number;
    title: string;
    lessons: BuilderLesson[];
    collapsed?: boolean;
  }

  // --- Wizard Steps & Modes ---
  type WizardStep = 'define' | 'upload' | 'prepare';
  let currentStep = $state<WizardStep>('define');

  type BuilderMode = 'ai' | 'archive' | 'manual';
  let activeMode = $state<BuilderMode>('ai');

  interface StepInfo {
    id: WizardStep;
    number: number;
    label: string;
    shortLabel: string;
  }

  let steps = $derived.by<StepInfo[]>(() => {
    if (activeMode === 'ai') {
      return [
        { id: 'define', number: 1, label: 'Define Course', shortLabel: 'Define' },
        { id: 'upload', number: 2, label: 'Upload Document', shortLabel: 'Upload' },
        { id: 'prepare', number: 3, label: 'Prepare Curriculum', shortLabel: 'Prepare' }
      ];
    } else if (activeMode === 'archive') {
      return [
        { id: 'define', number: 1, label: 'Define Course', shortLabel: 'Define' },
        { id: 'upload', number: 2, label: 'Upload Archive', shortLabel: 'Upload' }
      ];
    } else {
      return [
        { id: 'define', number: 1, label: 'Define Course', shortLabel: 'Define' },
        { id: 'prepare', number: 2, label: 'Prepare Curriculum', shortLabel: 'Prepare' }
      ];
    }
  });

  // --- Course Metadata State ---
  let courseTitle = $state('');
  let courseId = $state('');
  let grade = $state('11');
  let level = $state('University');
  let description = $state('');
  let queueStudyMaterials = $state(true);

  // --- Mode A (Archive) State ---
  let archiveFiles = $state<File[]>([]);
  let isDraggingArchive = $state(false);
  let isUploadingArchive = $state(false);

  // --- Mode B (AI Proposer) State ---
  type AiInputType = 'file' | 'text';
  let aiInputType = $state<AiInputType>('file');
  let aiFile = $state<File | null>(null);
  let aiText = $state('');
  let aiInstructions = $state('');
  let aiTargetUnits = $state(0);
  let isAnalyzingAi = $state(false);
  let aiAnalysisStep = $state('');
  let aiProposalSuccess = $state(false);

  // --- AI Architect Prompt Customization ---
  let isAiMenuOpen = $state(false);
  let isCustomPromptOpen = $state(false);
  let defaultBuilderPrompt = $state('');
  let customSystemPrompt = $state('');
  let selectedPromptPreset = $state('default');

  const PROMPT_PRESETS: Record<string, string> = {
    default: '',
    ontario: `# Course Builder Prompt: Ontario Secondary Curriculum

You are an expert Ontario Secondary School curriculum consultant and instructional designer.
Analyze the provided course material, syllabus, textbook, or document and propose a structured Ontario-compliant course curriculum.

### Instructions:
1. Extract or determine:
   - "title": Ontario Course Title (e.g. "Grade 11 Functions" or "Grade 12 Physics")
   - "suggestedId": Standard Ministry course code (e.g. "mcr3u", "sph4u", "eng4u")
   - "grade": Grade level (e.g. "9", "10", "11", "12")
   - "level": Stream ("University", "College", "University/College", "Workplace", "Open")
   - "description": Ontario syllabus course description aligned with Ministry curriculum expectations.
2. Structure into 4 to 5 core sequential Units.
3. Under each unit, include instructional Lessons followed by a Culminating Unit Assignment ("type": "assignment").
   - "id": Two-digit dot numbering ("01.01", "01.02", etc.)
   - "title": Curriculum topic title
   - "type": "lesson" or "assignment"
   - "content": Starter markdown outline with Specific Expectations, Learning Goals, and Key Concepts.

### Output Format:
Respond ONLY with a valid JSON object matching the standard schema without markdown backticks.`,

    textbook: `# Course Builder Prompt: Textbook & Academic Manual Ingestion

You are an expert academic curriculum editor.
Analyze the provided textbook chapter, manual, or lecture notes and convert them into a structured interactive course syllabus.

### Instructions:
1. Extract or determine:
   - "title": Textbook/Manual subject title
   - "suggestedId": Short alphanumeric course slug
   - "grade": Target academic level (e.g. "Introductory", "Intermediate", "Advanced")
   - "level": Academic destination
   - "description": Comprehensive textbook syllabus description.
2. Map each major section or chapter into a dedicated Unit (3 to 6 units).
3. Map individual sub-topics, theorems, or sections into individual Lessons:
   - "id": Dot-numbered ("01.01", "01.02", etc.)
   - "title": Topic title matching textbook section
   - "type": "lesson" (or "assignment" for chapter problem sets / review labs)
   - "content": Starter notes summarizing the key formulas, definitions, and worked examples.

### Output Format:
Respond ONLY with a valid JSON object matching the standard schema without markdown backticks.`,

    technical: `# Course Builder Prompt: Technical & Programming Curriculum

You are a senior software architect and technical educator.
Analyze the provided technical document, API documentation, framework guide, or programming outline and construct a hands-on developer course curriculum.

### Instructions:
1. Extract or determine:
   - "title": Technical course title (e.g. "Modern TypeScript Engineering" or "Distributed Systems in Go")
   - "suggestedId": Short developer-friendly code (e.g. "ts-arch", "go-dist")
   - "grade": "Undergraduate" or "Professional"
   - "level": "Technical"
   - "description": Developer syllabus with prerequisites and technical outcomes.
2. Structure into 3 to 5 Units progressing from architecture/prerequisites to production capstone.
3. Under each unit, pair conceptual lessons with practical coding exercises or lab assignments:
   - "id": Dot-numbered ("01.01", "01.02", etc.)
   - "title": Specific technical topic or hands-on lab
   - "type": "lesson" for conceptual lectures; "assignment" for coding challenges/labs
   - "content": Starter markdown with code snippets, architecture diagrams, and coding objectives.

### Output Format:
Respond ONLY with a valid JSON object matching the standard schema without markdown backticks.`,

    crash: `# Course Builder Prompt: High-Yield Crash Course & Review

You are an expert tutor specializing in rapid exam preparation and high-yield study reviews.
Analyze the provided course material and construct a fast-paced, high-yield crash course curriculum.

### Instructions:
1. Extract or determine:
   - "title": Accelerated Course Title (e.g. "AP Chemistry Fast-Track Review")
   - "suggestedId": Short course code
   - "grade": Target grade or test level
   - "level": Academic level
   - "description": High-yield revision syllabus focusing on high-probability exam concepts.
2. Structure into 3 to 4 dense, high-impact Units covering the core foundational domains.
3. Every unit should feature concise core topic lessons and finish with a diagnostic practice test or review assignment:
   - "id": Dot-numbered ("01.01", "01.02", etc.)
   - "title": High-yield concept title
   - "type": "lesson" or "assignment"
   - "content": Core definitions, essential formulas, and common exam pitfalls.

### Output Format:
Respond ONLY with a valid JSON object matching the standard schema without markdown backticks.`
  };

  onMount(async () => {
    try {
      const res = await apiFetch('/api/builder/prompt');
      if (res.ok) {
        const data = await res.json();
        defaultBuilderPrompt = data.prompt || '';
        customSystemPrompt = defaultBuilderPrompt;
        PROMPT_PRESETS.default = defaultBuilderPrompt;
      }
    } catch (e) {
      console.warn('Could not load default builder prompt:', e);
    }
  });

  function handlePromptPresetChange() {
    if (selectedPromptPreset === 'default') {
      customSystemPrompt = defaultBuilderPrompt;
    } else if (PROMPT_PRESETS[selectedPromptPreset]) {
      customSystemPrompt = PROMPT_PRESETS[selectedPromptPreset];
    }
  }

  function resetPromptToDefault() {
    selectedPromptPreset = 'default';
    customSystemPrompt = defaultBuilderPrompt;
  }

  let hasCustomPromptEdited = $derived(
    Boolean(customSystemPrompt && defaultBuilderPrompt && customSystemPrompt.trim() !== defaultBuilderPrompt.trim())
  );

  // --- Mode C / Interactive Curriculum Studio State ---
  let units = $state<BuilderUnit[]>([
    {
      number: 1,
      title: 'Unit 1: Foundations',
      collapsed: false,
      lessons: [
        {
          id: '01.01',
          title: 'Introduction & Core Concepts',
          type: 'lesson',
          content: '# Introduction & Core Concepts\n\n### Learning Goals\n- Understand the fundamentals\n- Identify key concepts\n\n### Overview\nWelcome to Lesson 1.',
          expanded: false
        }
      ]
    }
  ]);

  // --- Batch Add Modal State ---
  let showBatchModal = $state(false);
  let batchUnitIndex = $state(0);
  let batchLessonsText = $state('');

  // --- Form & Status State ---
  let isCreatingCourse = $state(false);
  let errorMessage = $state('');
  let successMessage = $state('');

  // --- Step Navigation Helpers ---
  function isStepCompleted(stepId: WizardStep): boolean {
    if (stepId === 'define') {
      return currentStep !== 'define';
    }
    if (stepId === 'upload') {
      return currentStep === 'prepare';
    }
    return false;
  }

  function canNavigateToStep(targetStep: WizardStep): boolean {
    if (targetStep === 'define') return true;
    if (targetStep === 'upload') {
      return Boolean(courseTitle.trim() || activeMode === 'archive');
    }
    if (targetStep === 'prepare') {
      if (activeMode === 'manual') return Boolean(courseTitle.trim());
      if (activeMode === 'ai') return Boolean(courseTitle.trim() && (aiProposalSuccess || units.length > 0));
    }
    return false;
  }

  function goToStep(targetStep: WizardStep) {
    errorMessage = '';
    if (targetStep === 'upload' || targetStep === 'prepare') {
      if (!courseTitle.trim() && activeMode !== 'archive') {
        errorMessage = 'Please enter a course title before proceeding.';
        return;
      }
      if (!courseId.trim()) {
        slugifyTitle();
      }
    }
    currentStep = targetStep;
  }

  function handleContinueFromDefine() {
    errorMessage = '';
    if (!courseTitle.trim() && activeMode !== 'archive') {
      errorMessage = 'Please enter a course title before proceeding.';
      return;
    }
    if (!courseId.trim()) {
      slugifyTitle();
    }
    if (activeMode === 'archive') {
      currentStep = 'upload';
    } else if (activeMode === 'ai') {
      currentStep = 'upload';
    } else {
      currentStep = 'prepare';
    }
  }

  // --- Auto-generate course ID slug ---
  function slugifyTitle() {
    if (!courseTitle.trim()) return;
    const slug = courseTitle
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 20);
    if (slug) {
      courseId = slug;
    }
  }

  function handleTitleInput() {
    if (!courseId) {
      slugifyTitle();
    }
  }

  // --- Statistics ---
  let totalUnitsCount = $derived(units.length);
  let totalLessonsCount = $derived(units.reduce((acc, u) => acc + u.lessons.filter((l) => l.type === 'lesson').length, 0));
  let totalAssignmentsCount = $derived(units.reduce((acc, u) => acc + u.lessons.filter((l) => l.type === 'assignment').length, 0));

  // --- Unit & Lesson Manipulation ---
  function addUnit() {
    const nextNum = units.length + 1;
    units = [
      ...units,
      {
        number: nextNum,
        title: `Unit ${nextNum}: New Unit`,
        collapsed: false,
        lessons: [
          {
            id: `${String(nextNum).padStart(2, '0')}.01`,
            title: 'Lesson 1',
            type: 'lesson',
            content: '',
            expanded: false
          }
        ]
      }
    ];
  }

  async function removeUnit(unitIndex: number) {
    if (units.length <= 1) {
      errorMessage = 'Courses must have at least one unit.';
      return;
    }
    const confirmed = await confirmDialog(
      `Are you sure you want to delete "${units[unitIndex].title}" and all its lessons?`,
      'Delete Unit'
    );
    if (confirmed) {
      units = units.filter((_, i) => i !== unitIndex);
      renumberEverything();
    }
  }

  function moveUnit(unitIndex: number, direction: 'up' | 'down') {
    const targetIndex = direction === 'up' ? unitIndex - 1 : unitIndex + 1;
    if (targetIndex < 0 || targetIndex >= units.length) return;
    const copy = [...units];
    const temp = copy[unitIndex];
    copy[unitIndex] = copy[targetIndex];
    copy[targetIndex] = temp;
    units = copy;
    renumberEverything();
  }

  function addLesson(unitIndex: number) {
    const unit = units[unitIndex];
    const uNum = unit.number;
    const lNum = unit.lessons.length + 1;
    const defaultId = `${String(uNum).padStart(2, '0')}.${String(lNum).padStart(2, '0')}`;

    unit.lessons.push({
      id: defaultId,
      title: `Lesson ${lNum}`,
      type: 'lesson',
      content: '',
      expanded: false
    });
    units = [...units];
  }

  function removeLesson(unitIndex: number, lessonIndex: number) {
    const unit = units[unitIndex];
    if (unit.lessons.length <= 1) {
      errorMessage = 'Units must have at least one lesson or assignment.';
      return;
    }
    unit.lessons.splice(lessonIndex, 1);
    renumberUnitLessons(unitIndex);
    units = [...units];
  }

  function moveLesson(unitIndex: number, lessonIndex: number, direction: 'up' | 'down') {
    const unit = units[unitIndex];
    const targetIndex = direction === 'up' ? lessonIndex - 1 : lessonIndex + 1;
    if (targetIndex < 0 || targetIndex >= unit.lessons.length) return;
    const temp = unit.lessons[lessonIndex];
    unit.lessons[lessonIndex] = unit.lessons[targetIndex];
    unit.lessons[targetIndex] = temp;
    renumberUnitLessons(unitIndex);
    units = [...units];
  }

  function toggleLessonType(unitIndex: number, lessonIndex: number) {
    const lesson = units[unitIndex].lessons[lessonIndex];
    lesson.type = lesson.type === 'lesson' ? 'assignment' : 'lesson';
    units = [...units];
  }

  function renumberUnitLessons(unitIndex: number) {
    const unit = units[unitIndex];
    const uNum = unit.number;
    unit.lessons.forEach((lesson, lIdx) => {
      const lNum = lIdx + 1;
      lesson.id = `${String(uNum).padStart(2, '0')}.${String(lNum).padStart(2, '0')}`;
    });
  }

  function renumberEverything() {
    units.forEach((unit, uIdx) => {
      unit.number = uIdx + 1;
      renumberUnitLessons(uIdx);
    });
    units = [...units];
  }

  function toggleExpandAll(expand: boolean) {
    units.forEach((u) => {
      u.collapsed = !expand;
    });
    units = [...units];
  }

  // --- Batch Add Lessons ---
  function openBatchModal(unitIndex = 0) {
    batchUnitIndex = unitIndex;
    batchLessonsText = '';
    showBatchModal = true;
  }

  function applyBatchLessons() {
    if (!batchLessonsText.trim()) {
      showBatchModal = false;
      return;
    }

    const lines = batchLessonsText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const unit = units[batchUnitIndex];
    if (!unit) return;

    for (const line of lines) {
      const isAssignment = /assignment|project|quiz|test|lab/i.test(line);
      const cleanTitle = line.replace(/^(\d+(\.\d+)?|\*|-|•|\[assignment\]|\[lesson\])\s*/i, '').trim();

      const uNum = unit.number;
      const lNum = unit.lessons.length + 1;
      const defaultId = `${String(uNum).padStart(2, '0')}.${String(lNum).padStart(2, '0')}`;

      unit.lessons.push({
        id: defaultId,
        title: cleanTitle || `Lesson ${lNum}`,
        type: isAssignment ? 'assignment' : 'lesson',
        content: '',
        expanded: false
      });
    }

    renumberUnitLessons(batchUnitIndex);
    units = [...units];
    showBatchModal = false;
  }

  // --- Starter Templates ---
  async function applyTemplate(type: 'ontario4' | 'syllabus10' | 'blank') {
    const confirmed = await confirmDialog(
      'Replace current curriculum with template? Any unsaved edits will be replaced.',
      'Apply Template'
    );
    if (!confirmed) return;

    if (type === 'blank') {
      units = [
        {
          number: 1,
          title: 'Unit 1: Overview',
          collapsed: false,
          lessons: [
            {
              id: '01.01',
              title: 'Introduction',
              type: 'lesson',
              content: '# Introduction\n\n### Learning Goals\n- Understand core concepts',
              expanded: false
            }
          ]
        }
      ];
    } else if (type === 'ontario4') {
      units = [
        {
          number: 1,
          title: 'Unit 1: Foundations and Core Principles',
          collapsed: false,
          lessons: [
            { id: '01.01', title: 'Course Orientation & Fundamentals', type: 'lesson', content: '' },
            { id: '01.02', title: 'Exploration & Analysis', type: 'lesson', content: '' },
            { id: '01.03', title: 'Applied Problem Solving', type: 'lesson', content: '' },
            { id: '01.04', title: 'Unit 1 Culminating Assignment', type: 'assignment', content: '' }
          ]
        },
        {
          number: 2,
          title: 'Unit 2: Intermediate Systems & Theories',
          collapsed: false,
          lessons: [
            { id: '02.01', title: 'Theoretical Models', type: 'lesson', content: '' },
            { id: '02.02', title: 'Case Studies & Practical Work', type: 'lesson', content: '' },
            { id: '02.03', title: 'Unit 2 Assessment Task', type: 'assignment', content: '' }
          ]
        },
        {
          number: 3,
          title: 'Unit 3: Advanced Applications & Synthesis',
          collapsed: false,
          lessons: [
            { id: '03.01', title: 'Specialized Topics', type: 'lesson', content: '' },
            { id: '03.02', title: 'Critical Evaluation & Methods', type: 'lesson', content: '' },
            { id: '03.03', title: 'Unit 3 Project', type: 'assignment', content: '' }
          ]
        },
        {
          number: 4,
          title: 'Unit 4: Capstone & Culminating Review',
          collapsed: false,
          lessons: [
            { id: '04.01', title: 'Course Review & Synthesis', type: 'lesson', content: '' },
            { id: '04.02', title: 'Final Culminating Assignment', type: 'assignment', content: '' }
          ]
        }
      ];
    } else if (type === 'syllabus10') {
      const tenWeeks: BuilderUnit[] = [];
      for (let i = 1; i <= 10; i++) {
        const uNum = i;
        tenWeeks.push({
          number: uNum,
          title: `Week ${uNum}: Topic ${uNum}`,
          collapsed: false,
          lessons: [
            { id: `${String(uNum).padStart(2, '0')}.01`, title: 'Lecture & Concepts', type: 'lesson', content: '' },
            { id: `${String(uNum).padStart(2, '0')}.02`, title: 'Workshop & Discussion', type: 'lesson', content: '' },
            { id: `${String(uNum).padStart(2, '0')}.03`, title: `Week ${uNum} Lab / Quiz`, type: 'assignment', content: '' }
          ]
        });
      }
      units = tenWeeks;
    }
  }

  // --- AI Starter Notes Generator for Single Lesson ---
  async function generateLessonContentWithAi(unitIndex: number, lessonIndex: number) {
    const unit = units[unitIndex];
    const lesson = unit.lessons[lessonIndex];
    lesson.generatingContent = true;
    errorMessage = '';

    try {
      const res = await apiFetch('/api/builder/generate-lesson', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          courseTitle: courseTitle || 'General Course',
          unitTitle: unit.title,
          lessonTitle: lesson.title,
          grade
        })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || 'Failed to generate lesson content.');
      }

      const data = await res.json();
      lesson.content = data.content;
      lesson.expanded = true;
      units = [...units];
    } catch (err: any) {
      errorMessage = err.message || 'Failed to generate starter notes.';
    } finally {
      lesson.generatingContent = false;
      units = [...units];
    }
  }

  // --- Mode A: File Handlers ---
  function handleArchiveFileSelect(e: Event) {
    const target = e.target as HTMLInputElement;
    if (target.files) {
      archiveFiles = Array.from(target.files).filter((f) => /\.(zip|mhtml|mht|html|htm)$/i.test(f.name));
    }
  }

  function handleArchiveDrop(e: DragEvent) {
    e.preventDefault();
    isDraggingArchive = false;
    if (e.dataTransfer?.files) {
      archiveFiles = Array.from(e.dataTransfer.files).filter((f) => /\.(zip|mhtml|mht|html|htm)$/i.test(f.name));
    }
  }

  // --- Mode B: AI Proposal Submission ---
  async function submitAiProposer() {
    errorMessage = '';
    successMessage = '';

    if (aiInputType === 'file' && !aiFile) {
      errorMessage = 'Please select a PDF, HTML, or text document to analyze.';
      return;
    }
    if (aiInputType === 'text' && !aiText.trim()) {
      errorMessage = 'Please paste course syllabus or outline text to analyze.';
      return;
    }

    isAnalyzingAi = true;
    aiAnalysisStep = 'Extracting and reading document content...';

    try {
      let res: Response;
      const isCustomizedPrompt = Boolean(
        customSystemPrompt.trim() &&
        defaultBuilderPrompt.trim() &&
        customSystemPrompt.trim() !== defaultBuilderPrompt.trim()
      );

      if (aiInputType === 'file' && aiFile) {
        aiAnalysisStep = 'Processing document through AI curriculum architect...';
        const formData = new FormData();
        formData.append('file', aiFile);
        if (aiInstructions.trim()) formData.append('instructions', aiInstructions.trim());
        if (aiTargetUnits > 0) formData.append('targetUnits', String(aiTargetUnits));
        if (isCustomizedPrompt) formData.append('customPrompt', customSystemPrompt.trim());

        res = await apiFetch('/api/builder/propose', {
          method: 'POST',
          body: formData
        });
      } else {
        aiAnalysisStep = 'Sending syllabus to AI curriculum architect...';
        res = await apiFetch('/api/builder/propose', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: aiText,
            instructions: aiInstructions,
            targetUnits: aiTargetUnits,
            customPrompt: isCustomizedPrompt ? customSystemPrompt.trim() : undefined
          })
        });
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || 'Failed to analyze document.');
      }

      const data = await res.json();
      const proposal = data.proposal;

      // Populate metadata if not already filled
      if (proposal.title && (!courseTitle || courseTitle === 'New Course')) {
        courseTitle = proposal.title;
      }
      if (proposal.suggestedId && !courseId) {
        courseId = proposal.suggestedId;
      }
      if (proposal.grade) grade = proposal.grade;
      if (proposal.level) level = proposal.level;
      if (proposal.description) description = proposal.description;

      // Populate units and lessons
      if (Array.isArray(proposal.units) && proposal.units.length > 0) {
        units = proposal.units.map((u: any, uIdx: number) => ({
          number: u.number || uIdx + 1,
          title: u.title || `Unit ${uIdx + 1}`,
          collapsed: false,
          lessons: (Array.isArray(u.lessons) ? u.lessons : []).map((l: any, lIdx: number) => ({
            id: l.id || `${String(uIdx + 1).padStart(2, '0')}.${String(lIdx + 1).padStart(2, '0')}`,
            title: l.title || `Lesson ${lIdx + 1}`,
            type: l.type === 'assignment' ? 'assignment' : 'lesson',
            content: l.content || '',
            expanded: false
          }))
        }));
      }

      aiProposalSuccess = true;
      successMessage = `Curriculum blueprint proposed with ${units.length} units and ${totalLessonsCount + totalAssignmentsCount} lessons!`;
      currentStep = 'prepare';
    } catch (err: any) {
      errorMessage = err.message || 'Failed to generate AI course proposal.';
    } finally {
      isAnalyzingAi = false;
      aiAnalysisStep = '';
    }
  }

  // --- Submit Course Creation (Mode A) ---
  async function submitArchiveCourse() {
    errorMessage = '';
    const finalCourseId = courseId.trim().toLowerCase();
    if (!finalCourseId) {
      errorMessage = 'Please provide a valid Course ID (e.g. "sph4u", "eng3u").';
      return;
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(finalCourseId)) {
      errorMessage = 'Invalid Course ID format. Use letters, numbers, hyphens, dots, or underscores.';
      return;
    }
    if (!archiveFiles.length) {
      errorMessage = 'Please select at least one archive file (.zip, .mhtml, .html).';
      return;
    }

    isUploadingArchive = true;
    try {
      const formData = new FormData();
      formData.append('courseId', finalCourseId);
      formData.append('mode', 'add');
      for (const f of archiveFiles) {
        formData.append('files', f);
      }

      const res = await apiFetch('/api/parse', {
        method: 'POST',
        body: formData
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Failed to ingest course archive.');
      }

      if (courseTitle.trim()) {
        await apiFetch(`/api/courses/${finalCourseId}/meta`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: courseTitle.trim(),
            description: description.trim()
          })
        }).catch(() => {});
      }

      if (queueStudyMaterials) {
        await apiFetch('/api/queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'enqueue',
            courseId: finalCourseId,
            tabs: ['summary', 'studysheet', 'test']
          })
        }).catch(() => {});
      }

      goto(`/courses/${finalCourseId}`);
    } catch (err: any) {
      errorMessage = err.message || 'Failed to ingest course archive.';
    } finally {
      isUploadingArchive = false;
    }
  }

  // --- Submit Course Creation (Mode B & C) ---
  async function submitVisualCourse() {
    errorMessage = '';
    successMessage = '';

    const finalTitle = courseTitle.trim();
    if (!finalTitle) {
      errorMessage = 'Please enter a course title before creating the course.';
      return;
    }

    const slugFromTitle = finalTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24);
    const finalCourseId = (courseId.trim() || slugFromTitle || `course-${Date.now().toString(36)}`).toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(finalCourseId)) {
      errorMessage = 'Invalid Course ID format. Must start with a letter/digit and contain only letters, numbers, hyphens, or dots.';
      return;
    }

    if (!units.length) {
      errorMessage = 'Course must contain at least one unit.';
      return;
    }

    isCreatingCourse = true;

    try {
      const payload = {
        id: finalCourseId,
        title: finalTitle,
        grade,
        level,
        description: description.trim(),
        units: units.map((u) => ({
          number: u.number,
          title: u.title,
          lessons: u.lessons.map((l) => ({
            id: l.id,
            title: l.title,
            type: l.type,
            content: l.content.trim() ? l.content : `# ${l.title}\n\n### Learning Goals\n- Understand key topics\n\n### Overview\nLesson content.`
          }))
        })),
        queueStudyMaterials
      };

      const res = await apiFetch('/api/courses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || 'Failed to create course.');
      }

      const data = await res.json().catch(() => ({}));
      if (data.course) {
        try {
          const store = await import('$lib/storage/clientStore');
          await store.saveCourseManifestLocally(finalCourseId, data.course);
        } catch (e) {
          console.warn('Could not cache course locally:', e);
        }
      }

      goto(`/courses/${finalCourseId}`);
    } catch (err: any) {
      console.error('Failed to create course:', err);
      errorMessage = err.message || 'Failed to create course.';
    } finally {
      isCreatingCourse = false;
    }
  }
</script>

<div class="min-h-screen bg-stone-50 dark:bg-stone-950 text-stone-900 dark:text-stone-100 flex flex-col">
  <Header courseTitle="Course Builder" />

  <main class="flex-1 max-w-5xl w-full mx-auto px-4 py-8 space-y-6">
    <!-- Top Header Banner -->
    <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-stone-200 dark:border-stone-800 pb-5">
      <div>
        <div class="flex items-center space-x-2 text-xs font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-500 mb-1">
          <BookOpen class="w-4 h-4" />
          <span>Course Creation Studio</span>
        </div>
        <h1 class="text-2xl md:text-3xl font-bold tracking-tight">Course Builder</h1>
        <p class="text-xs sm:text-sm text-stone-500 dark:text-stone-400 mt-1">
          {#if currentStep === 'define'}
            Step 1: Set course metadata and choose your preparation mode.
          {:else if currentStep === 'upload'}
            Step 2: Provide course materials for ingestion.
          {:else}
            Step 3: Review, edit, and organize curriculum units and lessons.
          {/if}
        </p>
      </div>

      <button
        type="button"
        onclick={() => goto('/')}
        class="inline-flex items-center space-x-2 px-3 py-1.5 rounded-lg border border-stone-200 dark:border-stone-800 text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 hover:bg-stone-100 dark:hover:bg-stone-900 transition text-xs font-medium self-start cursor-pointer"
      >
        <ArrowLeft class="w-3.5 h-3.5" />
        <span>Exit to Courses</span>
      </button>
    </div>

    <!-- Stepper Progress Bar -->
    <nav aria-label="Course builder progress" class="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-2xl p-2.5 sm:p-3 shadow-2xs">
      <ol class="flex items-center justify-between sm:justify-center sm:space-x-8">
        {#each steps as s, idx}
          <li class="flex items-center space-x-2 sm:space-x-4">
            <button
              type="button"
              disabled={!canNavigateToStep(s.id)}
              onclick={() => goToStep(s.id)}
              class={`flex items-center space-x-2 py-1 px-2 sm:px-3 sm:py-1.5 rounded-xl transition text-xs ${
                currentStep === s.id
                  ? 'bg-amber-500/10 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 font-semibold'
                  : isStepCompleted(s.id)
                  ? 'text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer font-medium'
                  : 'text-stone-400 dark:text-stone-600 opacity-60 cursor-not-allowed'
              }`}
            >
              <span
                class={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 transition ${
                  currentStep === s.id
                    ? 'bg-amber-600 dark:bg-amber-500 text-white dark:text-stone-950 shadow-2xs'
                    : isStepCompleted(s.id)
                    ? 'bg-emerald-600 dark:bg-emerald-500 text-white'
                    : 'border border-stone-300 dark:border-stone-700 text-stone-400'
                }`}
              >
                {#if isStepCompleted(s.id) && currentStep !== s.id}
                  <Check class="w-3.5 h-3.5 stroke-[3]" />
                {:else}
                  {s.number}
                {/if}
              </span>

              <span class="hidden sm:inline">{s.label}</span>
              <span class="sm:hidden">{s.shortLabel}</span>
            </button>

            {#if idx < steps.length - 1}
              <ChevronRight class="w-4 h-4 text-stone-300 dark:text-stone-700 shrink-0" />
            {/if}
          </li>
        {/each}
      </ol>
    </nav>

    <!-- Compact Course Context Bar (Shown in later stages) -->
    {#if currentStep !== 'define'}
      <div class="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-xl bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 text-xs shadow-2xs">
        <div class="flex items-center space-x-2.5 truncate">
          <span class="px-2 py-0.5 font-mono font-bold uppercase rounded-md bg-stone-100 dark:bg-stone-800 text-stone-800 dark:text-stone-200 border border-stone-200 dark:border-stone-700">
            {courseId.toUpperCase() || 'UNTITLED'}
          </span>
          <span class="font-semibold text-stone-900 dark:text-stone-100 truncate">
            {courseTitle || 'Untitled Course'}
          </span>
          <span class="text-stone-400">•</span>
          <span class="text-stone-500">
            Grade {grade} • {level}
          </span>
          <span class="text-stone-400 hidden sm:inline">•</span>
          <span class="hidden sm:inline px-2 py-0.5 rounded-full text-2xs font-medium bg-amber-500/10 text-amber-700 dark:text-amber-300">
            {activeMode === 'ai' ? 'PDF/Document AI' : activeMode === 'archive' ? 'ILC Archive' : 'Visual Studio'}
          </span>
        </div>

        <button
          type="button"
          onclick={() => goToStep('define')}
          class="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-lg border border-stone-200 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800 text-stone-600 dark:text-stone-300 transition text-xs font-medium cursor-pointer"
        >
          <Pencil class="w-3 h-3 text-amber-500" />
          <span>Edit Details</span>
        </button>
      </div>
    {/if}

    <!-- Alerts -->
    {#if errorMessage}
      <div class="p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 flex items-start space-x-3 text-red-800 dark:text-red-300 text-sm">
        <AlertCircle class="w-5 h-5 shrink-0 mt-0.5 text-red-600 dark:text-red-400" />
        <div class="flex-1">{errorMessage}</div>
        <button onclick={() => (errorMessage = '')} class="text-red-500 hover:text-red-700 cursor-pointer">
          <X class="w-4 h-4" />
        </button>
      </div>
    {/if}

    {#if successMessage}
      <div class="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/60 flex items-start space-x-3 text-emerald-800 dark:text-emerald-300 text-sm">
        <CheckCircle2 class="w-5 h-5 shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-400" />
        <div class="flex-1">{successMessage}</div>
        <button onclick={() => (successMessage = '')} class="text-emerald-500 hover:text-emerald-700 cursor-pointer">
          <X class="w-4 h-4" />
        </button>
      </div>
    {/if}

    <!-- ===================================================================== -->
    <!-- STAGE 1: DEFINE COURSE & SELECT PREPARATION MODE                       -->
    <!-- ===================================================================== -->
    {#if currentStep === 'define'}
      <div class="space-y-6">
        <!-- Course Identity Card -->
        <div class="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-2xl p-6 shadow-xs space-y-4">
          <div class="flex items-center justify-between">
            <h2 class="text-base font-semibold flex items-center space-x-2">
              <span class="w-5 h-5 rounded-full bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900 flex items-center justify-center text-xs font-bold">1</span>
              <span>Course Identity</span>
            </h2>
            <span class="text-xs text-stone-500">Essential course details & identifiers</span>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-12 gap-4">
            <!-- Course Title -->
            <div class="md:col-span-8 space-y-1.5">
              <label for="course-title" class="block text-xs font-medium text-stone-600 dark:text-stone-400">Course Title</label>
              <input
                id="course-title"
                type="text"
                bind:value={courseTitle}
                oninput={handleTitleInput}
                placeholder="e.g. Physics 12: Advanced Mechanics or Introduction to Psychology"
                class="w-full px-3.5 py-2 text-sm rounded-lg border border-stone-200 dark:border-stone-700 bg-stone-50/50 dark:bg-stone-950/50 focus:outline-hidden focus:ring-2 focus:ring-amber-500/50"
              />
            </div>

            <!-- Course Code / Slug -->
            <div class="md:col-span-4 space-y-1.5">
              <div class="flex items-center justify-between">
                <label for="course-id" class="block text-xs font-medium text-stone-600 dark:text-stone-400">Course ID / Code</label>
                <button
                  type="button"
                  onclick={slugifyTitle}
                  class="text-2xs text-amber-600 dark:text-amber-500 hover:underline cursor-pointer"
                >
                  Auto-slug
                </button>
              </div>
              <input
                id="course-id"
                type="text"
                bind:value={courseId}
                placeholder="e.g. sph4u, psych101"
                class="w-full px-3.5 py-2 text-sm font-mono lowercase rounded-lg border border-stone-200 dark:border-stone-700 bg-stone-50/50 dark:bg-stone-950/50 focus:outline-hidden focus:ring-2 focus:ring-amber-500/50"
              />
            </div>

            <!-- Grade / Year -->
            <div class="md:col-span-4 space-y-1.5">
              <label for="course-grade" class="block text-xs font-medium text-stone-600 dark:text-stone-400">Target Grade / Level</label>
              <select
                id="course-grade"
                bind:value={grade}
                class="w-full px-3 py-2 text-sm rounded-lg border border-stone-200 dark:border-stone-700 bg-stone-50/50 dark:bg-stone-950/50 focus:outline-hidden focus:ring-2 focus:ring-amber-500/50"
              >
                <option value="9">Grade 9</option>
                <option value="10">Grade 10</option>
                <option value="11">Grade 11</option>
                <option value="12">Grade 12</option>
                <option value="University">University</option>
                <option value="College">College</option>
                <option value="Introductory">Introductory</option>
                <option value="Advanced">Advanced</option>
              </select>
            </div>

            <!-- Stream / Academic Level -->
            <div class="md:col-span-4 space-y-1.5">
              <label for="course-level" class="block text-xs font-medium text-stone-600 dark:text-stone-400">Stream / Destination</label>
              <select
                id="course-level"
                bind:value={level}
                class="w-full px-3 py-2 text-sm rounded-lg border border-stone-200 dark:border-stone-700 bg-stone-50/50 dark:bg-stone-950/50 focus:outline-hidden focus:ring-2 focus:ring-amber-500/50"
              >
                <option value="University">University (U)</option>
                <option value="College">College (C)</option>
                <option value="University/College">University/College (M)</option>
                <option value="Workplace">Workplace (E)</option>
                <option value="Open">Open (O)</option>
                <option value="AP">Advanced Placement (AP)</option>
                <option value="IB">International Baccalaureate (IB)</option>
                <option value="General">General / Elective</option>
              </select>
            </div>

            <!-- Description -->
            <div class="md:col-span-12 space-y-1.5">
              <label for="course-desc" class="block text-xs font-medium text-stone-600 dark:text-stone-400">Course Syllabus Overview (Optional)</label>
              <textarea
                id="course-desc"
                rows="2"
                bind:value={description}
                placeholder="Brief 1-3 sentence summary of core learning goals and scope..."
                class="w-full px-3.5 py-2 text-sm rounded-lg border border-stone-200 dark:border-stone-700 bg-stone-50/50 dark:bg-stone-950/50 focus:outline-hidden focus:ring-2 focus:ring-amber-500/50"
              ></textarea>
            </div>
          </div>
        </div>

        <!-- Mode Selector Card -->
        <div class="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-2xl p-6 shadow-xs space-y-4">
          <div class="flex items-center justify-between">
            <h2 class="text-base font-semibold flex items-center space-x-2">
              <span class="w-5 h-5 rounded-full bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900 flex items-center justify-center text-xs font-bold">2</span>
              <span>Select Preparation Mode</span>
            </h2>
            <span class="text-xs text-stone-500">Pick how your course will be assembled</span>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
            <!-- Mode B: AI Proposer (Recommended) -->
            <button
              type="button"
              onclick={() => (activeMode = 'ai')}
              class={`flex flex-col text-left p-4 rounded-xl border transition cursor-pointer relative ${
                activeMode === 'ai'
                  ? 'bg-amber-500/5 dark:bg-amber-500/10 border-amber-500 dark:border-amber-500 ring-2 ring-amber-500/20'
                  : 'bg-white dark:bg-stone-900 border-stone-200 dark:border-stone-800 hover:border-stone-300 dark:hover:border-stone-700'
              }`}
            >
              <div class="flex items-center justify-between mb-2">
                <div class="p-2 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
                  <Sparkles class="w-5 h-5" />
                </div>
                <span class="px-2 py-0.5 text-2xs font-bold uppercase rounded-full bg-amber-100 dark:bg-amber-950/80 text-amber-700 dark:text-amber-300">
                  AI Powered
                </span>
              </div>
              <span class="font-semibold text-sm">PDF / Document AI</span>
              <span class="text-xs text-stone-500 dark:text-stone-400 mt-1">
                Upload a syllabus, textbook chapter, or paste outline to generate full layout.
              </span>
            </button>

            <!-- Mode A: ILC Archive -->
            <button
              type="button"
              onclick={() => (activeMode = 'archive')}
              class={`flex flex-col text-left p-4 rounded-xl border transition cursor-pointer ${
                activeMode === 'archive'
                  ? 'bg-amber-500/5 dark:bg-amber-500/10 border-amber-500 dark:border-amber-500 ring-2 ring-amber-500/20'
                  : 'bg-white dark:bg-stone-900 border-stone-200 dark:border-stone-800 hover:border-stone-300 dark:hover:border-stone-700'
              }`}
            >
              <div class="flex items-center justify-between mb-2">
                <div class="p-2 rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400">
                  <FileArchive class="w-5 h-5" />
                </div>
                <span class="px-2 py-0.5 text-2xs font-semibold uppercase rounded-full bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-400">
                  ILC Standard
                </span>
              </div>
              <span class="font-semibold text-sm">ILC Archive Upload</span>
              <span class="text-xs text-stone-500 dark:text-stone-400 mt-1">
                Upload ZIP / MHTML package with self-contained HTML lessons.
              </span>
            </button>

            <!-- Mode C: Visual Studio -->
            <button
              type="button"
              onclick={() => (activeMode = 'manual')}
              class={`flex flex-col text-left p-4 rounded-xl border transition cursor-pointer ${
                activeMode === 'manual'
                  ? 'bg-amber-500/5 dark:bg-amber-500/10 border-amber-500 dark:border-amber-500 ring-2 ring-amber-500/20'
                  : 'bg-white dark:bg-stone-900 border-stone-200 dark:border-stone-800 hover:border-stone-300 dark:hover:border-stone-700'
              }`}
            >
              <div class="flex items-center justify-between mb-2">
                <div class="p-2 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                  <Layers class="w-5 h-5" />
                </div>
                <span class="px-2 py-0.5 text-2xs font-semibold uppercase rounded-full bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-400">
                  Custom
                </span>
              </div>
              <span class="font-semibold text-sm">Visual Studio (Manual)</span>
              <span class="text-xs text-stone-500 dark:text-stone-400 mt-1">
                Build units and lessons manually from scratch or templates.
              </span>
            </button>
          </div>
        </div>

        <!-- Step 1 Bottom Action Bar -->
        <div class="flex items-center justify-between pt-2">
          <button
            type="button"
            onclick={() => goto('/')}
            class="px-4 py-2 rounded-xl border border-stone-200 dark:border-stone-800 text-xs font-medium text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
          >
            Cancel
          </button>

          <button
            type="button"
            onclick={handleContinueFromDefine}
            class="px-5 py-2.5 rounded-xl bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 font-semibold text-xs sm:text-sm hover:bg-stone-800 dark:hover:bg-white transition flex items-center space-x-2 shadow-xs cursor-pointer"
          >
            <span>
              {#if activeMode === 'archive'}
                Continue to Archive Upload
              {:else if activeMode === 'ai'}
                Continue to Document Upload
              {:else}
                Continue to Curriculum Studio
              {/if}
            </span>
            <ArrowRight class="w-4 h-4" />
          </button>
        </div>
      </div>
    {/if}

    <!-- ===================================================================== -->
    <!-- STAGE 2: UPLOAD MATERIALS (Mode A Archive OR Mode B Document AI)       -->
    <!-- ===================================================================== -->
    {#if currentStep === 'upload'}
      <div class="space-y-6">
        <!-- Sub-header with Back button -->
        <div class="flex items-center justify-between">
          <button
            type="button"
            onclick={() => (currentStep = 'define')}
            class="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border border-stone-200 dark:border-stone-800 hover:bg-stone-100 dark:hover:bg-stone-800 text-stone-600 dark:text-stone-300 transition text-xs font-medium cursor-pointer"
          >
            <ArrowLeft class="w-3.5 h-3.5" />
            <span>Back to Course Details</span>
          </button>

          {#if activeMode === 'ai' && (aiProposalSuccess || units.length > 0)}
            <button
              type="button"
              onclick={() => (currentStep = 'prepare')}
              class="inline-flex items-center space-x-1.5 text-xs text-amber-600 dark:text-amber-500 font-semibold hover:underline cursor-pointer"
            >
              <span>Skip to Curriculum Studio</span>
              <ArrowRight class="w-3.5 h-3.5" />
            </button>
          {/if}
        </div>

        <!-- Mode A: Archive Upload Panel -->
        {#if activeMode === 'archive'}
          <div class="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-2xl p-6 shadow-xs space-y-6">
            <div>
              <h3 class="text-base font-semibold">Upload Course Archive</h3>
              <p class="text-xs text-stone-500 mt-0.5">
                Accepts packaged ILC courses (.zip), offline archives (.mhtml), or standalone lesson HTML documents.
              </p>
            </div>

            <!-- Dropzone -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              ondragover={(e) => { e.preventDefault(); isDraggingArchive = true; }}
              ondragleave={() => (isDraggingArchive = false)}
              ondrop={handleArchiveDrop}
              class={`border-2 border-dashed rounded-xl p-8 text-center transition flex flex-col items-center justify-center cursor-pointer ${
                isDraggingArchive
                  ? 'border-amber-500 bg-amber-50/50 dark:bg-amber-950/20'
                  : 'border-stone-200 dark:border-stone-800 hover:border-stone-300 dark:hover:border-stone-700'
              }`}
            >
              <input
                type="file"
                id="archive-upload"
                multiple
                accept=".zip,.mhtml,.mht,.html,.htm"
                onchange={handleArchiveFileSelect}
                class="hidden"
              />
              <label for="archive-upload" class="cursor-pointer flex flex-col items-center space-y-2">
                <div class="p-3 rounded-full bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-400">
                  <Upload class="w-6 h-6" />
                </div>
                <div class="text-sm font-medium">Click to select files or drag and drop</div>
                <div class="text-xs text-stone-500">Supports .zip, .mhtml, .html</div>
              </label>
            </div>

            <!-- Selected Files List -->
            {#if archiveFiles.length > 0}
              <div class="space-y-2">
                <div class="text-xs font-semibold text-stone-500 uppercase tracking-wider">Selected Files ({archiveFiles.length})</div>
                <div class="divide-y divide-stone-100 dark:divide-stone-800 border border-stone-200 dark:border-stone-800 rounded-lg overflow-hidden">
                  {#each archiveFiles as file, idx}
                    <div class="p-3 flex items-center justify-between text-xs bg-stone-50/50 dark:bg-stone-950/50">
                      <div class="flex items-center space-x-2 truncate">
                        <FileArchive class="w-4 h-4 text-sky-500 shrink-0" />
                        <span class="truncate font-medium">{file.name}</span>
                        <span class="text-stone-400 text-2xs">({(file.size / 1024 / 1024).toFixed(2)} MB)</span>
                      </div>
                      <button
                        type="button"
                        onclick={() => (archiveFiles = archiveFiles.filter((_, i) => i !== idx))}
                        class="text-stone-400 hover:text-red-500 p-1 cursor-pointer"
                      >
                        <X class="w-4 h-4" />
                      </button>
                    </div>
                  {/each}
                </div>
              </div>
            {/if}

            <!-- Options -->
            <div class="p-4 rounded-xl bg-stone-50 dark:bg-stone-950/50 border border-stone-200 dark:border-stone-800">
              <label class="flex items-center space-x-3 cursor-pointer">
                <input
                  type="checkbox"
                  bind:checked={queueStudyMaterials}
                  class="w-4 h-4 rounded text-amber-600 focus:ring-amber-500"
                />
                <div>
                  <div class="text-xs font-medium">Queue AI Study Materials Generation</div>
                  <div class="text-2xs text-stone-500">Automatically enqueue Summaries, Studysheets, and Practice Tests in the background.</div>
                </div>
              </label>
            </div>

            <!-- Inline Error Alert -->
            {#if errorMessage}
              <div class="p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 flex items-start space-x-3 text-red-800 dark:text-red-300 text-sm">
                <AlertCircle class="w-5 h-5 shrink-0 mt-0.5 text-red-600 dark:text-red-400" />
                <div class="flex-1">{errorMessage}</div>
                <button type="button" onclick={() => (errorMessage = '')} class="text-red-500 hover:text-red-700 cursor-pointer">
                  <X class="w-4 h-4" />
                </button>
              </div>
            {/if}

            <!-- Submit Button -->
            <button
              type="button"
              disabled={isUploadingArchive || archiveFiles.length === 0}
              onclick={submitArchiveCourse}
              class="w-full py-2.5 px-4 rounded-xl bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 font-medium text-sm flex items-center justify-center space-x-2 hover:bg-stone-800 dark:hover:bg-white transition disabled:opacity-50 cursor-pointer shadow-xs"
            >
              {#if isUploadingArchive}
                <Loader2 class="w-4 h-4 animate-spin" />
                <span>Ingesting Archive & Extracting Lessons...</span>
              {:else}
                <Upload class="w-4 h-4" />
                <span>Ingest Archive & Open Course</span>
              {/if}
            </button>
          </div>
        {/if}

        <!-- Mode B: Document AI Panel -->
        {#if activeMode === 'ai'}
          <div class="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-2xl p-6 shadow-xs space-y-5">
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h3 class="text-base font-semibold flex items-center space-x-2">
                  <Sparkles class="w-4 h-4 text-amber-500" />
                  <span>AI Curriculum Architect</span>
                </h3>
                <p class="text-xs text-stone-500 mt-0.5">
                  Feed in a textbook outline, PDF syllabus, or lecture plan to generate a structured curriculum.
                </p>
              </div>

              <div class="flex items-center space-x-2 self-start sm:self-center">
                <!-- Sub-toggle: File vs Raw Text -->
                <div class="flex items-center space-x-1 p-1 bg-stone-100 dark:bg-stone-800 rounded-lg text-xs">
                  <button
                    type="button"
                    onclick={() => (aiInputType = 'file')}
                    class={`px-3 py-1 rounded-md font-medium transition cursor-pointer ${
                      aiInputType === 'file' ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-2xs' : 'text-stone-500'
                    }`}
                  >
                    Upload Document
                  </button>
                  <button
                    type="button"
                    onclick={() => (aiInputType = 'text')}
                    class={`px-3 py-1 rounded-md font-medium transition cursor-pointer ${
                      aiInputType === 'text' ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-2xs' : 'text-stone-500'
                    }`}
                  >
                    Paste Text
                  </button>
                </div>

                <!-- Vertical triple ellipsis for Prompt selection/editing -->
                <div class="relative inline-flex items-center">
                  <button
                    type="button"
                    onclick={() => (isAiMenuOpen = !isAiMenuOpen)}
                    class="relative flex items-center justify-center p-2 rounded-lg border border-stone-200 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-300 transition cursor-pointer shadow-2xs {isAiMenuOpen ? 'bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100' : ''}"
                    title="Curriculum Architect Prompt Settings"
                    aria-haspopup="menu"
                    aria-expanded={isAiMenuOpen}
                  >
                    <MoreVertical class="w-4 h-4" />
                    {#if isCustomPromptOpen || hasCustomPromptEdited}
                      <span class="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-500 border-2 border-white dark:border-stone-900" title="Custom prompt active"></span>
                    {/if}
                  </button>

                  {#if isAiMenuOpen}
                    <!-- Click outside backdrop -->
                    <div
                      class="fixed inset-0 z-40"
                      onclick={() => (isAiMenuOpen = false)}
                      aria-hidden="true"
                    ></div>

                    <div
                      role="menu"
                      tabindex="-1"
                      class="absolute right-0 top-full mt-1.5 w-52 rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 shadow-xl z-50 py-1 text-xs divide-y divide-stone-100 dark:divide-stone-800 animate-in fade-in zoom-in-95 duration-100"
                    >
                      <div class="py-1">
                        <button
                          type="button"
                          role="menuitem"
                          onclick={() => {
                            isAiMenuOpen = false;
                            isCustomPromptOpen = !isCustomPromptOpen;
                          }}
                          class="flex w-full items-center justify-between px-3 py-2 text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer text-left font-medium {isCustomPromptOpen ? 'text-amber-600 dark:text-amber-400 font-semibold' : ''}"
                        >
                          <div class="flex items-center space-x-2">
                            <Sparkles class="w-3.5 h-3.5 {isCustomPromptOpen ? 'text-amber-600 dark:text-amber-400' : 'text-stone-400'} shrink-0" />
                            <span>Curriculum Prompt</span>
                          </div>
                          {#if isCustomPromptOpen}
                            <span class="text-2xs text-amber-600 dark:text-amber-400 font-semibold">Open</span>
                          {:else if hasCustomPromptEdited}
                            <span class="text-2xs text-amber-600 dark:text-amber-400 font-semibold">Custom</span>
                          {/if}
                        </button>
                      </div>
                    </div>
                  {/if}
                </div>
              </div>
            </div>

            <!-- Collapsible Prompt Editor Card (revealed from MoreVertical menu) -->
            {#if isCustomPromptOpen}
              <div class="p-4 rounded-xl bg-stone-50 dark:bg-stone-950/80 border border-stone-200 dark:border-stone-800 space-y-3 animate-in fade-in zoom-in-95 duration-100">
                <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-stone-200/60 dark:border-stone-800/60 pb-3">
                  <div class="flex items-center space-x-2">
                    <Sparkles class="w-4 h-4 text-amber-500" />
                    <span class="text-xs font-semibold text-stone-900 dark:text-stone-100">Curriculum Architect System Prompt</span>
                    {#if hasCustomPromptEdited}
                      <span class="px-2 py-0.5 rounded-full text-2xs font-semibold bg-amber-100 dark:bg-amber-950/80 text-amber-700 dark:text-amber-300">
                        Customized
                      </span>
                    {/if}
                  </div>

                  <div class="flex items-center space-x-2 text-xs">
                    <!-- Preset selector -->
                    <select
                      bind:value={selectedPromptPreset}
                      onchange={handlePromptPresetChange}
                      class="px-2.5 py-1 text-2xs rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 focus:outline-hidden text-stone-700 dark:text-stone-300"
                    >
                      <option value="default">Preset: Standard Curriculum</option>
                      <option value="ontario">Preset: Ontario Secondary (KICA & Tasks)</option>
                      <option value="textbook">Preset: Textbook Chapter Ingestion</option>
                      <option value="technical">Preset: Coding & Technical Labs</option>
                      <option value="crash">Preset: High-Yield Crash Course</option>
                    </select>

                    <!-- Reset Button -->
                    <button
                      type="button"
                      onclick={resetPromptToDefault}
                      class="p-1.5 rounded-lg border border-stone-200 dark:border-stone-700 hover:bg-stone-200 dark:hover:bg-stone-800 text-stone-600 dark:text-stone-300 transition cursor-pointer"
                      title="Reset to default prompt"
                    >
                      <RotateCcw class="w-3.5 h-3.5" />
                    </button>

                    <!-- Close Button -->
                    <button
                      type="button"
                      onclick={() => (isCustomPromptOpen = false)}
                      class="p-1.5 rounded-lg hover:bg-stone-200 dark:hover:bg-stone-800 text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition cursor-pointer"
                      title="Close prompt editor"
                    >
                      <X class="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div class="space-y-1.5">
                  <textarea
                    rows="8"
                    bind:value={customSystemPrompt}
                    class="w-full px-3 py-2 text-xs font-mono rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 focus:outline-hidden focus:ring-1 focus:ring-amber-500 leading-relaxed text-stone-800 dark:text-stone-200"
                    placeholder="Enter custom curriculum architect prompt..."
                  ></textarea>
                  <div class="flex items-center justify-between text-2xs text-stone-500">
                    <span>The AI model follows this instruction when structuring units, lessons, and starter content from your uploaded document.</span>
                    <span>{customSystemPrompt.length} chars</span>
                  </div>
                </div>
              </div>
            {/if}

            {#if aiInputType === 'file'}
              <!-- File dropzone -->
              <div>
                <input
                  type="file"
                  id="ai-file-input"
                  accept=".pdf,.html,.htm,.txt,.md"
                  onchange={(e) => {
                    const target = e.target as HTMLInputElement;
                    if (target.files?.[0]) aiFile = target.files[0];
                  }}
                  class="hidden"
                />
                <label
                  for="ai-file-input"
                  class={`border-2 border-dashed rounded-xl p-8 text-center transition flex flex-col items-center justify-center cursor-pointer ${
                    aiFile
                      ? 'border-amber-500/50 bg-amber-50/20 dark:bg-amber-950/20'
                      : 'border-stone-200 dark:border-stone-800 hover:border-stone-300 dark:hover:border-stone-700'
                  }`}
                >
                  <div class="p-3 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 mb-2">
                    <Upload class="w-6 h-6" />
                  </div>
                  {#if aiFile}
                    <div class="text-sm font-semibold text-stone-900 dark:text-stone-100">{aiFile.name}</div>
                    <div class="text-xs text-stone-500 mt-1">{(aiFile.size / 1024 / 1024).toFixed(2)} MB • Click to replace file</div>
                  {:else}
                    <div class="text-sm font-medium">Select a syllabus or textbook PDF / Text file</div>
                    <div class="text-xs text-stone-500 mt-1">Accepts .pdf, .txt, .md, .html (max ~50 MB)</div>
                  {/if}
                </label>
              </div>
            {:else}
              <!-- Raw Text Paste -->
              <div class="space-y-1.5">
                <label for="ai-text-input" class="block text-xs font-medium text-stone-600 dark:text-stone-400">Course Syllabus or Lecture Plan Text</label>
                <textarea
                  id="ai-text-input"
                  rows="6"
                  bind:value={aiText}
                  placeholder="Paste course syllabus, unit breakdown, weekly schedule, or topic outline here..."
                  class="w-full px-3.5 py-2.5 text-xs font-mono rounded-lg border border-stone-200 dark:border-stone-700 bg-stone-50/50 dark:bg-stone-950/50 focus:outline-hidden focus:ring-2 focus:ring-amber-500/50"
                ></textarea>
              </div>
            {/if}

            <!-- Custom Instructions & Options -->
            <div class="grid grid-cols-1 md:grid-cols-12 gap-4">
              <div class="md:col-span-8 space-y-1.5">
                <label for="ai-instructions" class="block text-xs font-medium text-stone-600 dark:text-stone-400">Custom Architectural Instructions (Optional)</label>
                <input
                  id="ai-instructions"
                  type="text"
                  bind:value={aiInstructions}
                  placeholder="e.g. Break into 4 units, include culminating assignments, emphasize practical lab tasks"
                  class="w-full px-3.5 py-2 text-sm rounded-lg border border-stone-200 dark:border-stone-700 bg-stone-50/50 dark:bg-stone-950/50 focus:outline-hidden focus:ring-2 focus:ring-amber-500/50"
                />
              </div>

              <div class="md:col-span-4 space-y-1.5">
                <label for="ai-target-units" class="block text-xs font-medium text-stone-600 dark:text-stone-400">Target Unit Count</label>
                <select
                  id="ai-target-units"
                  bind:value={aiTargetUnits}
                  class="w-full px-3 py-2 text-sm rounded-lg border border-stone-200 dark:border-stone-700 bg-stone-50/50 dark:bg-stone-950/50 focus:outline-hidden focus:ring-2 focus:ring-amber-500/50"
                >
                  <option value={0}>Auto-detect from material</option>
                  <option value={3}>Exactly 3 Units</option>
                  <option value={4}>Exactly 4 Units</option>
                  <option value={5}>Exactly 5 Units</option>
                  <option value={6}>Exactly 6 Units</option>
                </select>
              </div>
            </div>

            <!-- Inline Error Alert -->
            {#if errorMessage}
              <div class="p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 flex items-start space-x-3 text-red-800 dark:text-red-300 text-sm">
                <AlertCircle class="w-5 h-5 shrink-0 mt-0.5 text-red-600 dark:text-red-400" />
                <div class="flex-1">{errorMessage}</div>
                <button type="button" onclick={() => (errorMessage = '')} class="text-red-500 hover:text-red-700 cursor-pointer">
                  <X class="w-4 h-4" />
                </button>
              </div>
            {/if}

            <!-- Propose Button -->
            <button
              type="button"
              disabled={isAnalyzingAi || (aiInputType === 'file' && !aiFile) || (aiInputType === 'text' && !aiText.trim())}
              onclick={submitAiProposer}
              class="w-full py-2.5 px-4 rounded-xl bg-amber-600 dark:bg-amber-500 text-white dark:text-stone-950 font-semibold text-sm flex items-center justify-center space-x-2 hover:bg-amber-700 dark:hover:bg-amber-400 transition disabled:opacity-50 cursor-pointer shadow-xs"
            >
              {#if isAnalyzingAi}
                <Loader2 class="w-4 h-4 animate-spin" />
                <span>{aiAnalysisStep || 'Analyzing Document & Synthesizing Curriculum...'}</span>
              {:else}
                <Sparkles class="w-4 h-4" />
                <span>Analyze Material & Propose Curriculum</span>
              {/if}
            </button>
          </div>
        {/if}
      </div>
    {/if}

    <!-- ===================================================================== -->
    <!-- STAGE 3: PREPARE CURRICULUM (Interactive Studio for Mode B & C)        -->
    <!-- ===================================================================== -->
    {#if currentStep === 'prepare'}
      <div class="space-y-6">
        <!-- Sub-header with Back button & Statistics -->
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div class="flex items-center space-x-3">
            <button
              type="button"
              onclick={() => {
                if (activeMode === 'ai') {
                  currentStep = 'upload';
                } else {
                  currentStep = 'define';
                }
              }}
              class="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border border-stone-200 dark:border-stone-800 hover:bg-stone-100 dark:hover:bg-stone-800 text-stone-600 dark:text-stone-300 transition text-xs font-medium cursor-pointer"
            >
              <ArrowLeft class="w-3.5 h-3.5" />
              <span>
                {activeMode === 'ai' ? 'Back to Document Upload' : 'Back to Course Details'}
              </span>
            </button>

            <div class="text-xs text-stone-500 flex items-center space-x-2">
              <span><strong>{totalUnitsCount}</strong> Units</span>
              <span>•</span>
              <span><strong>{totalLessonsCount}</strong> Lessons</span>
              <span>•</span>
              <span><strong>{totalAssignmentsCount}</strong> Assignments</span>
            </div>
          </div>

          <!-- Studio Toolbar Actions -->
          <div class="flex items-center flex-wrap gap-2 text-xs">
            <button
              type="button"
              onclick={() => toggleExpandAll(true)}
              class="px-2.5 py-1.5 rounded-lg border border-stone-200 dark:border-stone-800 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer text-stone-600 dark:text-stone-300"
            >
              Expand All
            </button>
            <button
              type="button"
              onclick={() => toggleExpandAll(false)}
              class="px-2.5 py-1.5 rounded-lg border border-stone-200 dark:border-stone-800 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer text-stone-600 dark:text-stone-300"
            >
              Collapse All
            </button>
            <button
              type="button"
              onclick={renumberEverything}
              class="px-2.5 py-1.5 rounded-lg border border-stone-200 dark:border-stone-800 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer text-stone-600 dark:text-stone-300"
            >
              Auto-Renumber
            </button>
            <button
              type="button"
              onclick={() => openBatchModal(0)}
              class="px-2.5 py-1.5 rounded-lg border border-stone-200 dark:border-stone-800 bg-stone-100 dark:bg-stone-800 hover:bg-stone-200 dark:hover:bg-stone-700 transition cursor-pointer font-medium flex items-center space-x-1"
            >
              <ListPlus class="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
              <span>Batch Add</span>
            </button>
            <button
              type="button"
              onclick={addUnit}
              class="px-3 py-1.5 rounded-lg bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 font-medium hover:bg-stone-800 dark:hover:bg-white transition cursor-pointer flex items-center space-x-1 shadow-2xs"
            >
              <Plus class="w-3.5 h-3.5" />
              <span>Add Unit</span>
            </button>
          </div>
        </div>

        <!-- Quick Starter Templates (Mode C only or if user wants to reset) -->
        {#if activeMode === 'manual' && units.length <= 1}
          <div class="p-4 rounded-xl bg-stone-100/60 dark:bg-stone-900/40 border border-stone-200 dark:border-stone-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <span class="text-xs text-stone-600 dark:text-stone-400 font-medium">Quick Starter Templates:</span>
            <div class="flex items-center space-x-2 text-2xs">
              <button
                type="button"
                onclick={() => applyTemplate('ontario4')}
                class="px-2.5 py-1 rounded-md bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 font-semibold hover:border-amber-500 transition cursor-pointer"
              >
                Ontario 4-Unit Standard
              </button>
              <button
                type="button"
                onclick={() => applyTemplate('syllabus10')}
                class="px-2.5 py-1 rounded-md bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 font-semibold hover:border-amber-500 transition cursor-pointer"
              >
                10-Week Syllabus
              </button>
              <button
                type="button"
                onclick={() => applyTemplate('blank')}
                class="px-2.5 py-1 rounded-md bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 font-semibold hover:border-amber-500 transition cursor-pointer"
              >
                Clean Slate
              </button>
            </div>
          </div>
        {/if}

        <!-- Units Accordion List -->
        <div class="space-y-4">
          {#each units as unit, unitIdx}
            <div class="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-2xl shadow-xs overflow-hidden transition">
              <!-- Unit Header -->
              <div class="p-4 bg-stone-50/50 dark:bg-stone-950/40 border-b border-stone-100 dark:border-stone-800/80 flex items-center justify-between gap-3">
                <div class="flex items-center space-x-3 flex-1 min-w-0">
                  <button
                    type="button"
                    onclick={() => (unit.collapsed = !unit.collapsed)}
                    class="p-1 rounded-md hover:bg-stone-200/60 dark:hover:bg-stone-800 text-stone-500 transition cursor-pointer"
                  >
                    {#if unit.collapsed}
                      <ChevronRight class="w-4 h-4" />
                    {:else}
                      <ChevronDown class="w-4 h-4" />
                    {/if}
                  </button>

                  <span class="px-2.5 py-1 rounded-md bg-stone-200 dark:bg-stone-800 text-stone-800 dark:text-stone-200 text-xs font-mono font-bold shrink-0">
                    Unit {unit.number}
                  </span>

                  <input
                    type="text"
                    bind:value={unit.title}
                    placeholder={`Unit ${unit.number} Title`}
                    class="font-semibold text-sm bg-transparent border-b border-transparent hover:border-stone-300 dark:hover:border-stone-700 focus:border-amber-500 focus:outline-hidden px-1 py-0.5 w-full max-w-md transition"
                  />
                </div>

                <!-- Unit Controls -->
                <div class="flex items-center space-x-1 text-xs">
                  <span class="text-2xs text-stone-400 font-medium mr-2 hidden sm:inline">
                    {unit.lessons.length} {unit.lessons.length === 1 ? 'item' : 'items'}
                  </span>

                  <!-- Move Unit Up -->
                  <button
                    type="button"
                    disabled={unitIdx === 0}
                    onclick={() => moveUnit(unitIdx, 'up')}
                    class="p-1.5 rounded-md hover:bg-stone-200/60 dark:hover:bg-stone-800 text-stone-500 disabled:opacity-30 cursor-pointer"
                    title="Move Unit Up"
                  >
                    <ArrowUp class="w-3.5 h-3.5" />
                  </button>

                  <!-- Move Unit Down -->
                  <button
                    type="button"
                    disabled={unitIdx === units.length - 1}
                    onclick={() => moveUnit(unitIdx, 'down')}
                    class="p-1.5 rounded-md hover:bg-stone-200/60 dark:hover:bg-stone-800 text-stone-500 disabled:opacity-30 cursor-pointer"
                    title="Move Unit Down"
                  >
                    <ArrowDown class="w-3.5 h-3.5" />
                  </button>

                  <!-- Add Lesson -->
                  <button
                    type="button"
                    onclick={() => addLesson(unitIdx)}
                    class="px-2 py-1 rounded-md bg-stone-100 dark:bg-stone-800 hover:bg-stone-200 dark:hover:bg-stone-700 text-stone-700 dark:text-stone-300 font-medium flex items-center space-x-1 cursor-pointer"
                  >
                    <Plus class="w-3 h-3" />
                    <span class="text-2xs">Lesson</span>
                  </button>

                  <!-- Batch Add to this Unit -->
                  <button
                    type="button"
                    onclick={() => openBatchModal(unitIdx)}
                    class="p-1.5 rounded-md hover:bg-stone-200/60 dark:hover:bg-stone-800 text-stone-500 cursor-pointer"
                    title="Batch Add Lessons to this Unit"
                  >
                    <ListPlus class="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                  </button>

                  <!-- Delete Unit -->
                  <button
                    type="button"
                    onclick={() => removeUnit(unitIdx)}
                    class="p-1.5 rounded-md hover:bg-red-50 dark:hover:bg-red-950/50 text-stone-400 hover:text-red-600 transition cursor-pointer"
                    title="Delete Unit"
                  >
                    <Trash2 class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <!-- Unit Lessons List (Collapsible) -->
              {#if !unit.collapsed}
                <div class="divide-y divide-stone-100 dark:divide-stone-800/60">
                  {#each unit.lessons as lesson, lessonIdx}
                    <div class="p-3.5 space-y-3 transition hover:bg-stone-50/30 dark:hover:bg-stone-950/20">
                      <!-- Lesson Row -->
                      <div class="flex items-center justify-between gap-3">
                        <div class="flex items-center space-x-2 flex-1 min-w-0">
                          <!-- Move controls -->
                          <div class="flex flex-col space-y-0.5 text-stone-400 shrink-0">
                            <button
                              type="button"
                              disabled={lessonIdx === 0}
                              onclick={() => moveLesson(unitIdx, lessonIdx, 'up')}
                              class="hover:text-stone-900 dark:hover:text-stone-100 disabled:opacity-20 cursor-pointer"
                            >
                              <ArrowUp class="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              disabled={lessonIdx === unit.lessons.length - 1}
                              onclick={() => moveLesson(unitIdx, lessonIdx, 'down')}
                              class="hover:text-stone-900 dark:hover:text-stone-100 disabled:opacity-20 cursor-pointer"
                            >
                              <ArrowDown class="w-3 h-3" />
                            </button>
                          </div>

                          <!-- Lesson ID Input -->
                          <input
                            type="text"
                            bind:value={lesson.id}
                            class="w-16 px-1.5 py-1 text-xs font-mono rounded-md border border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-950 text-center focus:outline-hidden focus:ring-1 focus:ring-amber-500"
                          />

                          <!-- Lesson Title Input -->
                          <input
                            type="text"
                            bind:value={lesson.title}
                            placeholder="Lesson or Assignment Topic"
                            class="flex-1 px-3 py-1 text-sm rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 focus:outline-hidden focus:ring-1 focus:ring-amber-500 min-w-0"
                          />
                        </div>

                        <!-- Type & Content Actions -->
                        <div class="flex items-center space-x-2 shrink-0">
                          <!-- Type Toggle Pill -->
                          <button
                            type="button"
                            onclick={() => toggleLessonType(unitIdx, lessonIdx)}
                            class={`px-2 py-0.5 text-2xs font-bold uppercase rounded-md transition cursor-pointer flex items-center space-x-1 ${
                              lesson.type === 'assignment'
                                ? 'bg-amber-100 dark:bg-amber-950/80 text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-800'
                                : 'bg-sky-100 dark:bg-sky-950/80 text-sky-700 dark:text-sky-300 border border-sky-300 dark:border-sky-800'
                            }`}
                            title="Click to switch between Lesson and Assignment"
                          >
                            {#if lesson.type === 'assignment'}
                              <GraduationCap class="w-3 h-3" />
                              <span>Assignment</span>
                            {:else}
                              <FileText class="w-3 h-3" />
                              <span>Lesson</span>
                            {/if}
                          </button>

                          <!-- Starter Content Toggle -->
                          <button
                            type="button"
                            onclick={() => (lesson.expanded = !lesson.expanded)}
                            class={`px-2 py-1 rounded-md text-xs font-medium transition cursor-pointer flex items-center space-x-1 ${
                              lesson.content.trim()
                                ? 'bg-stone-200/80 dark:bg-stone-800 text-stone-800 dark:text-stone-200'
                                : 'bg-stone-100 dark:bg-stone-800/50 text-stone-500 hover:text-stone-800 dark:hover:text-stone-200'
                            }`}
                          >
                            <FileCode class="w-3 h-3" />
                            <span class="text-2xs">{lesson.content.trim() ? 'Notes ✓' : 'Add Notes'}</span>
                          </button>

                          <!-- Delete Lesson -->
                          <button
                            type="button"
                            onclick={() => removeLesson(unitIdx, lessonIdx)}
                            class="p-1 rounded-md text-stone-400 hover:text-red-600 transition cursor-pointer"
                            title="Delete Lesson"
                          >
                            <X class="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      <!-- Expandable Lesson Notes Editor -->
                      {#if lesson.expanded}
                        <div class="p-3 bg-stone-50 dark:bg-stone-950/80 rounded-xl border border-stone-200 dark:border-stone-800/80 space-y-2">
                          <div class="flex items-center justify-between">
                            <span class="text-xs font-semibold text-stone-600 dark:text-stone-400 flex items-center space-x-1.5">
                              <FileCode class="w-3.5 h-3.5 text-amber-500" />
                              <span>Starter Markdown Content for "{lesson.title}"</span>
                            </span>

                            <div class="flex items-center space-x-2">
                              <!-- AI Generate Starter Notes -->
                              <button
                                type="button"
                                disabled={lesson.generatingContent}
                                onclick={() => generateLessonContentWithAi(unitIdx, lessonIdx)}
                                class="px-2 py-1 text-2xs font-semibold rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-400 hover:bg-amber-500/20 transition flex items-center space-x-1 cursor-pointer disabled:opacity-50"
                              >
                                {#if lesson.generatingContent}
                                  <Loader2 class="w-3 h-3 animate-spin" />
                                  <span>Generating...</span>
                                {:else}
                                  <Wand2 class="w-3 h-3" />
                                  <span>AI Generate Notes</span>
                                {/if}
                              </button>

                              <!-- Preview Toggle -->
                              <button
                                type="button"
                                onclick={() => (lesson.preview = !lesson.preview)}
                                class="px-2 py-1 text-2xs font-medium rounded-md bg-stone-200 dark:bg-stone-800 text-stone-700 dark:text-stone-300 hover:bg-stone-300 dark:hover:bg-stone-700 transition cursor-pointer"
                              >
                                {lesson.preview ? 'Editor' : 'Preview'}
                              </button>
                            </div>
                          </div>

                          {#if lesson.preview}
                            <div class="p-4 bg-white dark:bg-stone-900 rounded-lg border border-stone-200 dark:border-stone-800 text-xs prose dark:prose-invert max-w-none max-h-60 overflow-y-auto">
                              {#if lesson.content.trim()}
                                <MarkdownViewer markdown={lesson.content} courseId={courseId || 'preview'} />
                              {:else}
                                <span class="text-stone-400 italic">No notes written yet.</span>
                              {/if}
                            </div>
                          {:else}
                            <textarea
                              rows="6"
                              bind:value={lesson.content}
                              placeholder={`# ${lesson.title}\n\n### Learning Goals\n- Understand core concepts\n\n### Overview\nLesson notes and walkthrough...`}
                              class="w-full px-3 py-2 text-xs font-mono rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 focus:outline-hidden focus:ring-1 focus:ring-amber-500"
                            ></textarea>
                          {/if}
                        </div>
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>

        <!-- Options Card -->
        <div class="p-4 rounded-xl bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800">
          <label class="flex items-center space-x-3 cursor-pointer">
            <input
              type="checkbox"
              bind:checked={queueStudyMaterials}
              class="w-4 h-4 rounded text-amber-600 focus:ring-amber-500"
            />
            <div>
              <div class="text-xs font-medium">Queue AI Study Materials Generation</div>
              <div class="text-2xs text-stone-500">Automatically enqueue Summaries, Studysheets, and Practice Tests for all lessons upon course creation.</div>
            </div>
          </label>
        </div>

        <!-- Bottom Inline Error Alert -->
        {#if errorMessage}
          <div class="p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 flex items-start space-x-3 text-red-800 dark:text-red-300 text-sm">
            <AlertCircle class="w-5 h-5 shrink-0 mt-0.5 text-red-600 dark:text-red-400" />
            <div class="flex-1">{errorMessage}</div>
            <button type="button" onclick={() => (errorMessage = '')} class="text-red-500 hover:text-red-700 cursor-pointer">
              <X class="w-4 h-4" />
            </button>
          </div>
        {/if}

        <!-- Bottom Action CTA -->
        <div class="flex items-center justify-between gap-4 pt-4 border-t border-stone-200 dark:border-stone-800">
          <button
            type="button"
            onclick={() => {
              if (activeMode === 'ai') {
                currentStep = 'upload';
              } else {
                currentStep = 'define';
              }
            }}
            class="px-4 py-2.5 rounded-xl border border-stone-200 dark:border-stone-800 hover:bg-stone-100 dark:hover:bg-stone-900 text-xs font-medium text-stone-600 dark:text-stone-300 transition cursor-pointer"
          >
            Back
          </button>

          <button
            type="button"
            disabled={isCreatingCourse}
            onclick={submitVisualCourse}
            class="px-6 py-2.5 rounded-xl bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 font-semibold text-sm hover:bg-stone-800 dark:hover:bg-white transition flex items-center space-x-2 shadow-xs cursor-pointer disabled:opacity-50"
          >
            {#if isCreatingCourse}
              <Loader2 class="w-4 h-4 animate-spin" />
              <span>Creating Course & Injecting Lessons...</span>
            {:else}
              <Check class="w-4 h-4" />
              <span>Create Course</span>
            {/if}
          </button>
        </div>
      </div>
    {/if}
  </main>
</div>

<!-- Batch Add Lessons Modal -->
{#if showBatchModal}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs">
    <div class="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-2xl max-w-lg w-full p-6 shadow-xl space-y-4">
      <div class="flex items-center justify-between">
        <h3 class="font-bold text-base flex items-center space-x-2">
          <ListPlus class="w-5 h-5 text-amber-500" />
          <span>Batch Add Lessons</span>
        </h3>
        <button onclick={() => (showBatchModal = false)} class="text-stone-400 hover:text-stone-600 cursor-pointer">
          <X class="w-4 h-4" />
        </button>
      </div>

      <p class="text-xs text-stone-500">
        Paste a list of lesson titles (one per line). Lines with "assignment", "quiz", "test", or "project" will automatically be marked as assignments.
      </p>

      <div class="space-y-1.5">
        <label for="batch-target-unit" class="block text-xs font-medium text-stone-600 dark:text-stone-400">Target Unit</label>
        <select
          id="batch-target-unit"
          bind:value={batchUnitIndex}
          class="w-full px-3 py-2 text-xs rounded-lg border border-stone-200 dark:border-stone-700 bg-stone-50/50 dark:bg-stone-950/50 focus:outline-hidden"
        >
          {#each units as unit, idx}
            <option value={idx}>Unit {unit.number}: {unit.title}</option>
          {/each}
        </select>
      </div>

      <div class="space-y-1.5">
        <label for="batch-text" class="block text-xs font-medium text-stone-600 dark:text-stone-400">Lesson Titles (One per line)</label>
        <textarea
          id="batch-text"
          rows="8"
          bind:value={batchLessonsText}
          placeholder="1. Introduction to Motion&#10;2. Vectors and 2D Kinematics&#10;3. Newton's Laws&#10;4. [Assignment] Force & Motion Lab"
          class="w-full px-3 py-2 text-xs font-mono rounded-lg border border-stone-200 dark:border-stone-700 bg-stone-50/50 dark:bg-stone-950/50 focus:outline-hidden"
        ></textarea>
      </div>

      <div class="flex items-center justify-end space-x-2 pt-2">
        <button
          type="button"
          onclick={() => (showBatchModal = false)}
          class="px-3 py-1.5 rounded-lg border border-stone-200 dark:border-stone-800 text-xs font-medium hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
        >
          Cancel
        </button>
        <button
          type="button"
          onclick={applyBatchLessons}
          class="px-4 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-semibold hover:bg-amber-700 transition cursor-pointer shadow-2xs"
        >
          Add to Unit
        </button>
      </div>
    </div>
  </div>
{/if}

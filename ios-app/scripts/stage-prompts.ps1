# stage-prompts.ps1
# Copies the reviewed desktop prompt set into the iOS app resources before sync.
#
# Contract (ios-app/PLAN.md §1.4/§4.8):
#   * active set: summary, cheatsheet, popquiz, unit_assignments, unit_test,
#     course_summary, course_test, course_schedule
#   * backup-only files: test.md, course_cheatsheet.md
#   * exclude mcp_prompt_instructions.md, promtps.zip, .DS_Store, .mcp-token, backup/
#   * fail if a required prompt is missing or empty
#   * keep reviewed schema overrides for `test` and `course_test` so the output
#     schema shows the counts the prompt text requests (6 MC + 4 FIB and
#     12 MC + 4 multi-part). Never reintroduce the legacy 2+2 schema.
#   * write prompt-manifest.json with hashes, provenance, and expected counts

[CmdletBinding()]
param(
    [string]$SourceRoot = "C:\Users\Meeoowz\Documents\ILC\_ILC-APP-DATA\prompts",
    [string]$Destination = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Destination)) {
    $Destination = Join-Path $PSScriptRoot "..\CourseDeck\Resources\Prompts"
}

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Utf8NoBom {
    param([string]$Path, [string]$Text)
    [System.IO.File]::WriteAllText($Path, $Text, $Utf8NoBom)
}

function Assert-Text {
    param([string]$Text, [string]$Needle, [string]$PromptId)
    if ($Text.IndexOf($Needle, [System.StringComparison]::Ordinal) -lt 0) {
        throw "Prompt '$PromptId' no longer contains required text: '$Needle'. Review the source prompt before staging."
    }
}

function Get-SchemaSection {
    param([string]$Text, [string]$StartMarker, [string]$EndMarker = $null)
    $start = $Text.IndexOf($StartMarker, [System.StringComparison]::Ordinal)
    if ($start -lt 0) { throw "Schema marker '$StartMarker' not found." }
    if ([string]::IsNullOrEmpty($EndMarker)) {
        return $Text.Substring($start)
    }
    $end = $Text.IndexOf($EndMarker, $start, [System.StringComparison]::Ordinal)
    if ($end -lt 0) { throw "Schema end marker '$EndMarker' not found." }
    return $Text.Substring($start, $end - $start)
}

# Reviewed schema override for `test` (6 MC + 4 FIB). Applied deterministically
# after copying backup/test.md, replacing the legacy 2-question schema.
$TestSchema = @'
## Output Schema:
course: <COURSE_ID>.<UNIT>.<LESSON>

# Lesson <LESSON_NUM>: <TITLE>

## Questions
01) [Knowledge & Understanding] <Question prompt>
<Multiple-Choice>
- [ ] <Option A>
- [ ] <Option B>
- [ ] <Option C>
- [ ] <Option D>

--

02) [Thinking & Investigation] <Question prompt>
<Multiple-Choice>
- [ ] <Option A>
- [ ] <Option B>
- [ ] <Option C>
- [ ] <Option D>

--

03) [Communication] <Question prompt>
<Multiple-Choice>
- [ ] <Option A>
- [ ] <Option B>
- [ ] <Option C>
- [ ] <Option D>

--

04) [Application] <Question prompt>
<Multiple-Choice>
- [ ] <Option A>
- [ ] <Option B>
- [ ] <Option C>
- [ ] <Option D>

--

05) [Knowledge & Understanding] <Question prompt>
<Multiple-Choice>
- [ ] <Option A>
- [ ] <Option B>
- [ ] <Option C>
- [ ] <Option D>

--

06) [Application] <Question prompt>
<Multiple-Choice>
- [ ] <Option A>
- [ ] <Option B>
- [ ] <Option C>
- [ ] <Option D>

--

## Fill-in-the-Blank
07) [Fill-in-the-Blank] <Sentence containing a _______ blank testing a key idea>

--

08) [Fill-in-the-Blank] <Sentence containing a _______ blank testing a key idea>

--

09) [Fill-in-the-Blank] <Sentence containing a _______ blank testing a key idea>

--

10) [Fill-in-the-Blank] <Sentence containing a _______ blank testing a key idea>

--

## Answers
01) B - (explanation) <Detailed rationale explaining why B is correct and citing specific lesson concepts>.
02) A - (explanation) <Detailed rationale explaining why A is correct and citing specific lesson concepts>.
03) C - (explanation) <Detailed rationale explaining why C is correct and citing specific lesson concepts>.
04) D - (explanation) <Detailed rationale explaining why D is correct and citing specific lesson concepts>.
05) B - (explanation) <Detailed rationale explaining why B is correct and citing specific lesson concepts>.
06) A - (explanation) <Detailed rationale explaining why A is correct and citing specific lesson concepts>.
07) [Target Word or Phrase] - (explanation) <Brief explanation citing specific lesson concepts>.
08) [Target Word or Phrase] - (explanation) <Brief explanation citing specific lesson concepts>.
09) [Target Word or Phrase] - (explanation) <Brief explanation citing specific lesson concepts>.
10) [Target Word or Phrase] - (explanation) <Brief explanation citing specific lesson concepts>.
'@

# Reviewed schema override for `course_test` (12 MC + 4 multi-part = 16).
$CourseTestSchema = @'
## Output Schema:
course: <COURSE_ID> - Final Exam

# Comprehensive Final Course Practice Exam

## Questions
01) [Knowledge & Understanding] <Question prompt>
<Multiple-Choice>
- [ ] <Option A>
- [ ] <Option B>
- [ ] <Option C>
- [ ] <Option D>

--

02) [Knowledge & Understanding] <Question prompt>
<Multiple-Choice>
- [ ] <Option A>
- [ ] <Option B>
- [ ] <Option C>
- [ ] <Option D>

--

03) [Knowledge & Understanding] <Question prompt>
<Multiple-Choice>
- [ ] <Option A>
- [ ] <Option B>
- [ ] <Option C>
- [ ] <Option D>

--

04) [Thinking & Investigation] <Question prompt>
<Multiple-Choice>
- [ ] <Option A>
- [ ] <Option B>
- [ ] <Option C>
- [ ] <Option D>

--

05) [Thinking & Investigation] <Question prompt>
<Multiple-Choice>
- [ ] <Option A>
- [ ] <Option B>
- [ ] <Option C>
- [ ] <Option D>

--

06) [Thinking & Investigation] <Question prompt>
<Multiple-Choice>
- [ ] <Option A>
- [ ] <Option B>
- [ ] <Option C>
- [ ] <Option D>

--

07) [Communication] <Question prompt>
<Multiple-Choice>
- [ ] <Option A>
- [ ] <Option B>
- [ ] <Option C>
- [ ] <Option D>

--

08) [Communication] <Question prompt>
<Multiple-Choice>
- [ ] <Option A>
- [ ] <Option B>
- [ ] <Option C>
- [ ] <Option D>

--

09) [Communication] <Question prompt>
<Multiple-Choice>
- [ ] <Option A>
- [ ] <Option B>
- [ ] <Option C>
- [ ] <Option D>

--

10) [Application] <Question prompt>
<Multiple-Choice>
- [ ] <Option A>
- [ ] <Option B>
- [ ] <Option C>
- [ ] <Option D>

--

11) [Application] <Question prompt>
<Multiple-Choice>
- [ ] <Option A>
- [ ] <Option B>
- [ ] <Option C>
- [ ] <Option D>

--

12) [Application] <Question prompt>
<Multiple-Choice>
- [ ] <Option A>
- [ ] <Option B>
- [ ] <Option C>
- [ ] <Option D>

--

## Comprehensive Short Answer / Case Problems
01) <Multi-unit problem prompt>
02) <Multi-unit problem prompt>
03) <Multi-unit problem prompt>
04) <Multi-unit problem prompt>

--

## Answers & Detailed Solutions
01) B - (explanation) <Detailed rationale explaining why B is correct, citing the specific course unit concepts>.
02) A - (explanation) <Detailed rationale explaining why A is correct, citing the specific course unit concepts>.
03) C - (explanation) <Detailed rationale explaining why C is correct, citing the specific course unit concepts>.
04) D - (explanation) <Detailed rationale explaining why D is correct, citing the specific course unit concepts>.
05) B - (explanation) <Detailed rationale explaining why B is correct, citing the specific course unit concepts>.
06) A - (explanation) <Detailed rationale explaining why A is correct, citing the specific course unit concepts>.
07) C - (explanation) <Detailed rationale explaining why C is correct, citing the specific course unit concepts>.
08) D - (explanation) <Detailed rationale explaining why D is correct, citing the specific course unit concepts>.
09) B - (explanation) <Detailed rationale explaining why B is correct, citing the specific course unit concepts>.
10) A - (explanation) <Detailed rationale explaining why A is correct, citing the specific course unit concepts>.
11) C - (explanation) <Detailed rationale explaining why C is correct, citing the specific course unit concepts>.
12) D - (explanation) <Detailed rationale explaining why D is correct, citing the specific course unit concepts>.

### Comprehensive Short Answer / Case Problem Solutions
01) <Expected Criteria / Rubric> - (explanation) <Detailed rationale and key points the student must articulate>.
02) <Expected Criteria / Rubric> - (explanation) <Detailed rationale and key points the student must articulate>.
03) <Expected Criteria / Rubric> - (explanation) <Detailed rationale and key points the student must articulate>.
04) <Expected Criteria / Rubric> - (explanation) <Detailed rationale and key points the student must articulate>.
'@

$ActivePrompts = @(
    "summary",
    "cheatsheet",
    "popquiz",
    "unit_assignments",
    "unit_test",
    "course_summary",
    "course_test",
    "course_schedule"
)

$BackupPrompts = @{
    "test"             = "test.md"
    "course_cheatsheet" = "course_cheatsheet.md"
}

$RequiredPrompts = @($ActivePrompts + @($BackupPrompts.Keys) | Sort-Object)
$ExcludedNames = @("mcp_prompt_instructions.md", "promtps.zip", ".DS_Store", ".mcp-token")

if (-not (Test-Path -LiteralPath $SourceRoot)) {
    throw "Prompt source root not found: $SourceRoot"
}

$Destination = [System.IO.Path]::GetFullPath($Destination)
$backupRoot = Join-Path $SourceRoot "backup"

if (-not (Test-Path -LiteralPath $Destination)) {
    New-Item -ItemType Directory -Path $Destination | Out-Null
}

# Remove previously staged prompts/manifest so a removed source cannot linger.
Get-ChildItem -LiteralPath $Destination -File | Where-Object {
    $_.Name -ne "README.md" -and ($_.Extension -eq ".md" -or $_.Name -eq "prompt-manifest.json")
} | Remove-Item -Force

$staged = @()

foreach ($id in $ActivePrompts) {
    $source = Join-Path $SourceRoot "$id.md"
    if (-not (Test-Path -LiteralPath $source)) {
        throw "Required prompt '$id.md' is missing from $SourceRoot"
    }
    $text = [System.IO.File]::ReadAllText($source)
    if ([string]::IsNullOrWhiteSpace($text)) {
        throw "Required prompt '$id.md' is empty."
    }
    Write-Utf8NoBom -Path (Join-Path $Destination "$id.md") -Text $text
    $staged += [PSCustomObject]@{ Id = $id; Source = "active"; Path = "$id.md"; Patched = $false }
}

foreach ($id in $BackupPrompts.Keys) {
    $source = Join-Path $backupRoot $BackupPrompts[$id]
    if (-not (Test-Path -LiteralPath $source)) {
        throw "Required backup prompt '$($BackupPrompts[$id])' is missing from $backupRoot"
    }
    $text = [System.IO.File]::ReadAllText($source)
    if ([string]::IsNullOrWhiteSpace($text)) {
        throw "Required backup prompt '$($BackupPrompts[$id])' is empty."
    }
    Write-Utf8NoBom -Path (Join-Path $Destination "$id.md") -Text $text
    $staged += [PSCustomObject]@{ Id = $id; Source = "backup"; Path = "$id.md"; Patched = $false }
}

# --- Deterministic schema patches -----------------------------------------
# test: source requests 6 MC + 4 FIB; the legacy schema showed 2 + 2.
$testPath = Join-Path $Destination "test.md"
$testText = [System.IO.File]::ReadAllText($testPath)
Assert-Text -Text $testText -Needle "Generate 6 multiple choice" -PromptId "test"
Assert-Text -Text $testText -Needle "generate 4 fill-in-the-blank" -PromptId "test"
$marker = "## Output Schema"
$markerIndex = $testText.IndexOf($marker, [System.StringComparison]::Ordinal)
if ($markerIndex -lt 0) { throw "test.md has no '$marker' section to override." }
$patched = $testText.Substring(0, $markerIndex).TrimEnd() + "`n`n" + $TestSchema.TrimEnd() + "`n"
Write-Utf8NoBom -Path $testPath -Text $patched

# course_test: source requests 12 MC + 4 multi-part; the legacy schema showed 2 + 2.
$courseTestPath = Join-Path $Destination "course_test.md"
$courseTestText = [System.IO.File]::ReadAllText($courseTestPath)
Assert-Text -Text $courseTestText -Needle "Generate **12 Multiple Choice Questions**" -PromptId "course_test"
Assert-Text -Text $courseTestText -Needle "Generate **4 Comprehensive Multi-Part Questions**" -PromptId "course_test"
$markerIndex = $courseTestText.IndexOf($marker, [System.StringComparison]::Ordinal)
if ($markerIndex -lt 0) { throw "course_test.md has no '$marker' section to override." }
$patched = $courseTestText.Substring(0, $markerIndex).TrimEnd() + "`n`n" + $CourseTestSchema.TrimEnd() + "`n"
Write-Utf8NoBom -Path $courseTestPath -Text $patched

foreach ($entry in $staged) {
    if ($entry.Id -eq "test" -or $entry.Id -eq "course_test") {
        $entry.Patched = $true
    }
}

# --- Validate the patched schemas -----------------------------------------
$testText = [System.IO.File]::ReadAllText($testPath)
$mcSection = Get-SchemaSection -Text $testText -StartMarker "## Questions" -EndMarker "## Fill-in-the-Blank"
$fibSection = Get-SchemaSection -Text $testText -StartMarker "## Fill-in-the-Blank" -EndMarker "## Answers"
$answerSection = Get-SchemaSection -Text $testText -StartMarker "## Answers"
$testMCCount = ([regex]::Matches($mcSection, "(?m)^\d{2}\)")).Count
$testFIBCount = ([regex]::Matches($fibSection, "(?m)^\d{2}\)")).Count
$testAnswerCount = ([regex]::Matches($answerSection, "(?m)^\d{2}\)")).Count
if ($testMCCount -ne 6 -or $testFIBCount -ne 4 -or $testAnswerCount -ne 10) {
    throw "Staged test.md schema has $testMCCount MC, $testFIBCount FIB, $testAnswerCount answers (expected 6/4/10)."
}

$courseTestText = [System.IO.File]::ReadAllText($courseTestPath)
$courseMC = Get-SchemaSection -Text $courseTestText -StartMarker "## Questions" -EndMarker "## Comprehensive Short Answer / Case Problems"
$courseSA = Get-SchemaSection -Text $courseTestText -StartMarker "## Comprehensive Short Answer / Case Problems" -EndMarker "## Answers & Detailed Solutions"
$courseAnswers = Get-SchemaSection -Text $courseTestText -StartMarker "## Answers & Detailed Solutions" -EndMarker "### Comprehensive Short Answer / Case Problem Solutions"
$courseSASolutions = Get-SchemaSection -Text $courseTestText -StartMarker "### Comprehensive Short Answer / Case Problem Solutions"
$courseMCCount = ([regex]::Matches($courseMC, "(?m)^\d{2}\)")).Count
$courseSACount = ([regex]::Matches($courseSA, "(?m)^\d{2}\)")).Count
$courseAnswerCount = ([regex]::Matches($courseAnswers, "(?m)^\d{2}\)")).Count
$courseSASolutionCount = ([regex]::Matches($courseSASolutions, "(?m)^\d{2}\)")).Count
if ($courseMCCount -ne 12 -or $courseSACount -ne 4 -or $courseAnswerCount -ne 12 -or $courseSASolutionCount -ne 4) {
    throw "Staged course_test.md schema has $courseMCCount MC, $courseSACount multi-part, $courseAnswerCount MC answers, $courseSASolutionCount SA solutions (expected 12/4/12/4)."
}

# --- Validate request text for the remaining counted prompts --------------
$unitTestText = [System.IO.File]::ReadAllText((Join-Path $Destination "unit_test.md"))
Assert-Text -Text $unitTestText -Needle "**8 Multiple Choice Questions**" -PromptId "unit_test"
Assert-Text -Text $unitTestText -Needle "**2 Fill-in-the-Blank Questions**" -PromptId "unit_test"
Assert-Text -Text $unitTestText -Needle "**2 Short-Answer / Problem-Solving Questions**" -PromptId "unit_test"

$popQuizText = [System.IO.File]::ReadAllText((Join-Path $Destination "popquiz.md"))
Assert-Text -Text $popQuizText -Needle "Exactly 4 Multiple-Choice questions" -PromptId "popquiz"
Assert-Text -Text $popQuizText -Needle "Exactly 2 Fill-in-the-Blank questions" -PromptId "popquiz"

# --- Exclusions -----------------------------------------------------------
$stagedFiles = Get-ChildItem -LiteralPath $Destination -File
foreach ($excluded in $ExcludedNames) {
    if ($stagedFiles.Name -contains $excluded) {
        throw "Excluded file '$excluded' was staged."
    }
}
if (Test-Path -LiteralPath (Join-Path $Destination "backup")) {
    throw "The backup/ directory must not be staged."
}

$stagedIds = @($staged | ForEach-Object { $_.Id })
foreach ($required in $RequiredPrompts) {
    if ($stagedIds -notcontains $required) {
        throw "Required prompt '$required' was not staged."
    }
}

# --- Manifest -------------------------------------------------------------
$entries = foreach ($entry in $staged) {
    $path = Join-Path $Destination $entry.Path
    $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    $length = (Get-Item -LiteralPath $path).Length
    $schemaPatch = $null
    if ($entry.Patched) { $schemaPatch = "schema-counts-v1" }
    [ordered]@{
        id           = $entry.Id
        file         = $entry.Path
        source       = $entry.Source
        protected    = $true
        patched      = $entry.Patched
        schemaPatch  = $schemaPatch
        sha256       = $hash
        bytes        = $length
    }
}

$manifest = [ordered]@{
    manifestVersion = 1
    generatedAt     = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    sourceRoot      = $SourceRoot
    destination     = "CourseDeck/Resources/Prompts"
    requiredPrompts = $RequiredPrompts
    optionalProtected = @("lesson", "test_kica")
    excluded        = $ExcludedNames + @("backup/")
    expectedQuestionCounts = [ordered]@{
        test = [ordered]@{ multipleChoice = 6; fillInTheBlank = 4; total = 10 }
        course_test = [ordered]@{ multipleChoice = 12; multiPart = 4; total = 16 }
        unit_test = [ordered]@{ multipleChoice = 8; fillInTheBlank = 2; shortAnswer = 2; total = 12 }
        popquiz = [ordered]@{ multipleChoice = 4; fillInTheBlank = 2; total = 6 }
    }
    prompts = @($entries)
}

$manifestPath = Join-Path $Destination "prompt-manifest.json"
Write-Utf8NoBom -Path $manifestPath -Text ($manifest | ConvertTo-Json -Depth 8)

Write-Host "Staged $($staged.Count) prompts into $Destination" -ForegroundColor Green
Write-Host "  required: $($RequiredPrompts -join ', ')" -ForegroundColor Gray
Write-Host "  patched:  test (6 MC + 4 FIB), course_test (12 MC + 4 multi-part)" -ForegroundColor Gray
Write-Host "  manifest: $manifestPath" -ForegroundColor Gray

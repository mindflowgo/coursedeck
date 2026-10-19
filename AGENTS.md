# CourseDeck Agent Guidelines

## 1. Course & Curriculum Data Access
- **Always use the `coursedeck` MCP server**:
  - `get_lesson_doc`: Fetch lesson markdown (`tab: "lesson"`) or generated tabs (`summary`, `cheatsheet`, `test`, `notes`, `schedule`).
  - `get_course`: Inspect course metadata, units, and curriculum structure.
  - `list_lessons`: Query lessons for a specific course or unit.
  - `list_courses`: List all registered courses and their status.
  - `search_course`: Full-text search across courses and lesson tabs.

## 2. File Reading & Execution Hygiene
- **Never spawn `python3` or shell scripts solely to read files** or ad-hoc read scripts.
- **For repository code**: Use the native file reader (ex. `view_file`) tool rather than shell commands (`cat`, `head`, `tail`).
- **For course data**: Always route through `coursedeck` MCP tools instead of reading raw files from the `data/` directory or root directory.

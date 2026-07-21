---
name: obsidian
description: Tools and guidelines for interacting with Obsidian vaults, creating Markdown notes with frontmatter, wikilinks, Mermaid diagrams, and Obsidian Canvas diagrams.
---

# Obsidian Skill for AEGIS System

Use this skill when interacting with Obsidian vaults or generating documentation for Obsidian.

## Note Conventions
1. **Frontmatter**: Every Obsidian note should begin with YAML frontmatter:
   ```yaml
   ---
   title: Note Title
   tags: [aegis, architecture, module]
   type: documentation
   created: 2026-07-20
   ---
   ```
2. **Wikilinks**: Connect related notes using standard Obsidian Wikilinks: `[[Note Name]]` or `[[Note Name|Custom Display Label]]`.
3. **Mermaid Diagrams**: Use standard Mermaid fenced blocks for flowcharts, sequence diagrams, and class/ER diagrams:
   ```mermaid
   graph TD
       A[HUB] --> B[Drive]
   ```
4. **Obsidian Canvas**: Support `.canvas` JSON structure for visual diagramming.

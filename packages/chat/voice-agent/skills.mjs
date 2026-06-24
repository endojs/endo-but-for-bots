// skills.mjs — a SKILL LIBRARY as an object capability. A "skill" is a
// drop-in folder under a skills/ root containing a SKILL.md describing it (the
// "skills as folders" pattern, sibling to server.mjs). makeSkillLibrary({root})
// returns an object that LISTS the available skills (folders that hold a
// SKILL.md) and reads one skill's text by name. It is confined to its root:
// a name is treated as a single path segment, so "../x" or "/etc/passwd" can
// never escape the skills directory — an unknown / traversing name returns
// null rather than reading anything outside root.
import fs from 'node:fs';
import path from 'node:path';

// A skill name must be a single, well-formed directory segment: no slashes, no
// path separators, no "." / ".." traversal, no NUL. Anything else is rejected
// up front (returns null) so we never even stat a path outside the root.
const isSafeName = name =>
  typeof name === 'string' &&
  name.length > 0 &&
  name !== '.' &&
  name !== '..' &&
  !name.includes('/') &&
  !name.includes('\\') &&
  !name.includes('\0') &&
  !path.isAbsolute(name);

// makeSkillLibrary({ root }) → { root, skillList(), skillText(name) }
//   skillList()      → sorted array of skill names (sub-dirs of root that contain a SKILL.md)
//   skillText(name)  → the SKILL.md text for that skill, or null if missing/unsafe
export const makeSkillLibrary = ({ root } = {}) => {
  if (!root) throw new Error('makeSkillLibrary requires a root');
  const skillsRoot = path.resolve(root);

  const skillList = () => {
    let ents = [];
    try {
      ents = fs.readdirSync(skillsRoot, { withFileTypes: true });
    } catch {
      return []; // fresh / missing root → empty
    }
    return ents
      .filter(e => e.isDirectory() && isSafeName(e.name))
      .filter(e => {
        try {
          return fs.statSync(path.join(skillsRoot, e.name, 'SKILL.md')).isFile();
        } catch {
          return false;
        }
      })
      .map(e => e.name)
      .sort();
  };

  const skillText = name => {
    if (!isSafeName(name)) return null;
    const file = path.join(skillsRoot, name, 'SKILL.md');
    // Defence in depth: the resolved file must live directly under root.
    const expectedDir = path.join(skillsRoot, name);
    if (path.dirname(file) !== expectedDir || path.dirname(expectedDir) !== skillsRoot) {
      return null;
    }
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) return null;
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  };

  return { root: skillsRoot, skillList, skillText };
};

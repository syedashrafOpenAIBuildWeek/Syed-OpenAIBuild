const escape = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export function destructiveManifests(
  targets,
  extraComponents = [],
  apiVersion = "67.0"
) {
  const byType = new Map();
  for (const target of targets) {
    for (const item of target.ownedMetadata || []) {
      if (!item.deleteWithTarget || !item.retrieveName) continue;
      byType.set(item.type, [
        ...(byType.get(item.type) || []),
        item.retrieveName
      ]);
    }
    const type = target.targetType === "field" ? "CustomField" : "CustomObject";
    const member =
      target.targetType === "field"
        ? `${target.objectApiName}.${target.fieldApiName}`
        : target.objectApiName;
    byType.set(type, [...(byType.get(type) || []), member]);
  }
  // Components whose only content was a reference to the target(s) being
  // deleted - the AI edit reduced them to nothing, so they get destructively
  // deleted alongside the target instead of deployed as an empty/invalid file.
  for (const item of extraComponents || []) {
    if (!item?.type || !item?.name) continue;
    byType.set(item.type, [...(byType.get(item.type) || []), item.name]);
  }
  const types = [...byType]
    .map(
      ([name, members]) =>
        `  <types>\n${members.map((m) => `    <members>${escape(m)}</members>`).join("\n")}\n    <name>${name}</name>\n  </types>`
    )
    .join("\n");
  const empty = `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n  <version>${apiVersion}</version>\n</Package>\n`;
  const destructive = `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${types}\n  <version>${apiVersion}</version>\n</Package>\n`;
  return { packageXml: empty, destructiveXml: destructive };
}

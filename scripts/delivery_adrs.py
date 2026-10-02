"""Small Markdown ADR contracts; callers supply files from the actual reviewed tree."""
import posixpath
import re

ADR_PATH = re.compile(r"docs/adr/ADR-(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md")
LINK = re.compile(r"\[ADR-(\d{4})\]\((ADR-\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md)\)")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def parse(path, content):
    match = ADR_PATH.fullmatch(path)
    require(match is not None and isinstance(content, str), "Invalid ADR path or content")
    number = match[1]
    require(number != "0000" and re.match(rf"# ADR-{number}: \S[^\n]*\n", content), "Missing ADR title/ID")
    data = {"number": int(number)}
    for field in ("Status", "Supersedes", "Superseded by"):
        values = re.findall(rf"^{field}: (.+)$", content, re.M)
        require(len(values) == 1, f"Missing/duplicate ADR {field}")
        value = values[0]
        if field == "Status":
            require(value in {"accepted", "deprecated"}, "Invalid ADR status")
            data[field] = value
            continue
        links = LINK.findall(value)
        require(value == "none" or (links and ", ".join(
            f"[ADR-{id}]({name})" for id, name in links) == value), "Invalid ADR replacement links")
        require(all(name.startswith(f"ADR-{id}-") for id, name in links), "ADR link ID mismatch")
        paths = ["docs/adr/" + name for _, name in links]
        require(len(paths) == len(set(paths)) and (field != "Superseded by" or len(paths) <= 1),
                "Duplicate or multiple ADR successors")
        data[field] = paths
    for heading in ("Context", "Decision", "Consequences", "Spec references"):
        sections = re.findall(rf"^## {heading}\n(.*?)(?=^## |\Z)", content, re.M | re.S)
        require(len(sections) == 1 and sections[0].strip(), f"Missing/empty ADR {heading}")
        data[heading] = sections[0]
    data["prose"] = re.sub(r"^(?:Status|Superseded by): .+\n", "", content, flags=re.M)
    return data


def validate_documents(documents):
    parsed = {path: parse(path, content) for path, content in documents.items()}
    numbers = [adr["number"] for adr in parsed.values()]
    require(len(numbers) == len(set(numbers)), "Duplicate ADR ID")
    for path, adr in parsed.items():
        successors = adr["Superseded by"]
        require(bool(successors) == (adr["Status"] == "deprecated"), "ADR status/successor mismatch")
        for old in adr["Supersedes"]:
            require(old in parsed and parsed[old]["number"] < adr["number"], "Missing or non-earlier ADR predecessor")
            require(parsed[old]["Superseded by"] == [path], "ADR predecessor lacks reciprocal link")
        for new in successors:
            require(new in parsed and path in parsed[new]["Supersedes"], "ADR successor lacks reciprocal link")
    return parsed


def validate_changes(before, after, declared, spec_updates=()):
    """A new decision and metadata-only deprecation ship in the same affected PR."""
    parsed = validate_documents(after)
    changed = {path for path in before.keys() | after.keys() if before.get(path) != after.get(path)}
    require(changed == set(declared), "Declared ADRs must exactly match changed ADR files")
    require(not before.keys() - after.keys(), "ADRs cannot be deleted")
    new = after.keys() - before.keys()
    for path in changed:
        current = parsed[path]
        if path in new:
            require(current["Status"] == "accepted", "New ADR must be accepted")
        else:
            previous = parse(path, before[path])
            require(previous["Status"] == "accepted" and current["Status"] == "deprecated"
                    and previous["prose"] == current["prose"]
                    and set(current["Superseded by"]) <= new, "Existing ADR may only be deprecated by a new ADR; preserve its prose")
    references = {posixpath.normpath(posixpath.join("docs/adr", target.split("#", 1)[0]))
                  for path in new for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", parsed[path]["Spec references"])}
    require(set(spec_updates) <= references, "Spec updates must be explained/referenced by a new accepted ADR")
    return new

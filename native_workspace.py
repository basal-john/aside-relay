"""Allowlisted bridge to Aside's native workspace and settings procedures."""
from __future__ import annotations

import asyncio
import re
import uuid
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx
from fastapi import APIRouter, HTTPException, Query

from daemon import ACCOUNT_ID, daemon


router = APIRouter(prefix="/api/native/workspace", tags=["native-workspace"])

PREFERENCE_KEYS = {
    "agentTabs",
    "agentTaskNotifications",
    "completionSound",
    "defaultPermissionMode",
    "followUpBehavior",
    "permission",
    "sidebarRecentChatLimit",
    "sidepanelSessionOnTabChange",
    "timezone",
}
SECRET_KEYS = re.compile(
    r"(^|_)(api[-_]?key|authorization(?:[-_]?url)?|client[-_]?secret|credential|env|headers?|"
    r"password|private[-_]?key|(?:access|refresh)[-_]?token|secret|token)(s)?$",
    re.IGNORECASE,
)
URL_SECRET_KEYS = re.compile(r"code|key|secret|signature|state|token", re.IGNORECASE)
SKILL_FRONTMATTER = re.compile(r"^---\r?\n[\s\S]*?\r?\n---\r?\n?")
SKILL_PASSWORD_MANAGER_NAMES = {
    "1password", "apple-passwords", "bitwarden", "dashlane", "lastpass", "password-manager",
}
SKILL_SYSTEM_NAMES = {
    "aside", "captcha-solver", "draft-preview", "image-search", "imagegen",
    "notification-activation", "skill-creator", "visual-browse", "visualize",
}
SKILL_HIDDEN_NAMES = {
    "1password", "dashlane", "kakaotalk", "lastpass", "linkedin", "onboarding",
    "proton-pass", "x-twitter",
}
PREFERENCE_WRITE_LOCK = asyncio.Lock()


def _input(payload: dict, allowed: set[str], *, required: set[str] | None = None) -> dict:
    if not isinstance(payload, dict) or not set(payload).issubset(allowed):
        raise HTTPException(400, "Invalid settings.")
    missing = (required or set()) - set(payload)
    if missing:
        raise HTTPException(400, f"Missing required field: {sorted(missing)[0]}")
    return payload


def _text(value: object, field: str, *, maximum: int = 500) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > maximum:
        raise HTTPException(400, f"Invalid {field}.")
    return value.strip()


def _safe_url(value: str) -> str:
    try:
        parts = urlsplit(value)
        query = urlencode([
            (key, "[redacted]" if URL_SECRET_KEYS.search(key) else item)
            for key, item in parse_qsl(parts.query, keep_blank_values=True)
        ])
        hostname = parts.hostname or ""
        if parts.port:
            hostname += f":{parts.port}"
        return urlunsplit((parts.scheme, hostname, parts.path, query, ""))
    except ValueError:
        return "[redacted]"


def _redact(value: object, key: str = "") -> object:
    if SECRET_KEYS.search(key):
        if key.lower() == "auth" and isinstance(value, dict):
            return {item_key: _redact(item_value, item_key) for item_key, item_value in value.items()}
        return "[redacted]" if value not in (None, "", {}, []) else value
    if isinstance(value, dict):
        return {item_key: _redact(item_value, item_key) for item_key, item_value in value.items()}
    if isinstance(value, list):
        return [_redact(item) for item in value]
    if isinstance(value, str) and key.lower().endswith("url"):
        return _safe_url(value)
    return value


async def _call(procedure: str, value: dict | None = None, *, mutation: bool = False):
    try:
        result = await daemon.call(
            procedure,
            {"accountId": ACCOUNT_ID, **(value or {})},
            mutation=mutation,
        )
        return _redact(result)
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text.lower()
        if "no procedure" in detail or "not found on type" in detail:
            raise HTTPException(501, "This Aside version does not support that feature.") from exc
        if exc.response.status_code == 404:
            raise HTTPException(404, "Native resource not found.") from exc
        if exc.response.status_code in {400, 409, 422}:
            raise HTTPException(exc.response.status_code, "Aside rejected these settings.") from exc
        raise HTTPException(502, "Aside could not complete this request.") from exc
    except (ConnectionError, httpx.HTTPError, KeyError, TimeoutError) as exc:
        raise HTTPException(503, "Aside is unavailable.") from exc


async def _settings() -> dict:
    settings = await _call("settings.getAll")
    if not isinstance(settings, dict):
        raise HTTPException(502, "Aside returned invalid settings.")
    return settings


def _project_id(value: object) -> str:
    return _text(value, "project ID", maximum=120)


@router.get("")
async def workspace():
    procedures = {
        "projects": ("projects.list", {}),
        "routines": ("routines.list", {}),
        "skills": ("projects.listSkillsForSettings", {"projectId": None}),
        "providers": ("models.listSettingsInventory", {}),
        "account": ("accounts.get", {}),
        "devices": ("accounts.auth.devices", {}),
        "memoryFiles": ("memory.listFiles", {}),
        "contextStatus": ("contextAwareness.historyStatus", {}),
    }
    keys = list(procedures)
    results = await asyncio.gather(
        _settings(),
        *(_call(procedure, value) for procedure, value in procedures.values()),
        return_exceptions=True,
    )
    if isinstance(results[0], Exception):
        return {"available": False, "capabilities": {}, "sections": {}}

    settings = results[0]
    loaded = dict(zip(keys, results[1:], strict=True))

    def result(name: str, fallback):
        value = loaded[name]
        return fallback if isinstance(value, Exception) else value

    capabilities = {
        "projects": not isinstance(loaded["projects"], Exception),
        "routines": not isinstance(loaded["routines"], Exception),
        "memories": not isinstance(loaded["memoryFiles"], Exception),
        "contextAwareness": not isinstance(loaded["contextStatus"], Exception),
        "skills": not isinstance(loaded["skills"], Exception),
        "connections": isinstance(settings.get("mcp"), dict),
        "providers": not isinstance(loaded["providers"], Exception),
        "account": not isinstance(loaded["account"], Exception),
        "preferences": True,
        "projectInstructions": not isinstance(loaded["projects"], Exception),
        "skillCatalog": not isinstance(loaded["skills"], Exception),
        "skillCustomization": not isinstance(loaded["skills"], Exception),
        "toolPermissions": isinstance(settings.get("permission"), dict),
    }
    mcp = settings.get("mcp") if isinstance(settings.get("mcp"), dict) else {}
    return {
        "available": True,
        "capabilities": capabilities,
        "sections": {
            "projects": result("projects", []),
            "routines": result("routines", []),
            "memories": {
                "preferences": settings.get("memory", {}),
                "files": result("memoryFiles", []),
            },
            "contextAwareness": {
                "settings": settings.get("contextAwareness", {}),
                "status": result("contextStatus", None),
            },
            "skills": result("skills", []),
            "connections": {
                "servers": _connection_list(mcp.get("servers", {})),
                "inventories": mcp.get("inventories", {}),
            },
            "providers": result("providers", {}),
            "account": {
                "profile": result("account", None),
                "devices": result("devices", []),
            },
            "preferences": {key: settings.get(key) for key in PREFERENCE_KEYS},
        },
    }


@router.get("/projects")
async def list_projects():
    return await _call("projects.list")


@router.post("/projects")
async def create_project(payload: dict):
    value = _input(payload, {"id", "name", "workspacePath"}, required={"name", "workspacePath"})
    return await _call("projects.create", {
        "id": _project_id(value.get("id") or uuid.uuid4().hex),
        "name": _text(value["name"], "project name", maximum=120),
        "workspacePath": _text(value["workspacePath"], "workspace path", maximum=4096),
    }, mutation=True)


@router.get("/projects/{project_id}")
async def get_project(project_id: str):
    return await _call("projects.get", {"projectId": _project_id(project_id)})


@router.patch("/projects/{project_id}")
async def update_project(project_id: str, payload: dict):
    value = _input(payload, {"name", "workspacePath"})
    if not value:
        raise HTTPException(400, "No project changes supplied.")
    if "name" in value:
        value["name"] = _text(value["name"], "project name", maximum=120)
    if "workspacePath" in value:
        value["workspacePath"] = _text(value["workspacePath"], "workspace path", maximum=4096)
    return await _call("projects.update", {"projectId": _project_id(project_id), **value}, mutation=True)


@router.delete("/projects/{project_id}")
async def delete_project(project_id: str):
    return await _call("projects.delete", {"projectId": _project_id(project_id)}, mutation=True)


@router.post("/projects/{project_id}/archive")
async def archive_project(project_id: str):
    return await _call("projects.archive", {"projectId": _project_id(project_id)}, mutation=True)


@router.post("/projects/{project_id}/move-session")
async def move_session_to_project(project_id: str, payload: dict):
    value = _input(payload, {"sessionId"}, required={"sessionId"})
    return await _call("sessions.moveToProject", {
        "sessionId": _text(value["sessionId"], "session ID", maximum=160),
        "projectId": _project_id(project_id),
    }, mutation=True)


@router.get("/projects/{project_id}/instructions")
async def project_instructions(project_id: str):
    return await _call("projects.readFile", {
        "projectId": _project_id(project_id),
        "fileName": "AGENTS.md",
    })


@router.patch("/projects/{project_id}/instructions")
async def update_project_instructions(project_id: str, payload: dict):
    value = _input(payload, {"content"}, required={"content"})
    if not isinstance(value["content"], str) or len(value["content"]) > 2_000_000:
        raise HTTPException(400, "Invalid project instructions.")
    return await _call("projects.writeFile", {
        "projectId": _project_id(project_id),
        "fileName": "AGENTS.md",
        "content": value["content"],
    }, mutation=True)


@router.get("/routines")
async def list_routines(project_id: str | None = Query(default=None)):
    value = {"projectId": project_id} if project_id else {}
    return await _call("routines.list", value)


@router.post("/routines")
async def create_routine(payload: dict):
    value = _input(payload, {
        "name", "prompt", "rrule", "projectId", "attachment", "environment",
        "browserBinding", "sessionConfig", "deviceId",
    }, required={"name", "prompt", "rrule"})
    value["name"] = _text(value["name"], "routine name", maximum=160)
    value["prompt"] = _text(value["prompt"], "routine prompt", maximum=100_000)
    settings = await _settings()
    value.setdefault("environment", "device")
    value.setdefault("attachment", {"type": "standalone"})
    value.setdefault("sessionConfig", {
        "model": settings.get("defaultModel"),
        "permissionMode": settings.get("defaultPermissionMode"),
        "notificationsEnabled": True,
    })
    return await _call("routines.create", value, mutation=True)


@router.get("/routines/{routine_id}")
async def get_routine(routine_id: str):
    return await _routine(routine_id)


async def _routine(routine_id: str) -> dict:
    result = await _call("routines.get", {"routineId": _text(routine_id, "routine ID", maximum=160)})
    if not isinstance(result, dict):
        raise HTTPException(404, "Routine not found.")
    return result


@router.patch("/routines/{routine_id}")
async def update_routine(routine_id: str, payload: dict):
    value = _input(payload, {"name", "prompt", "rrule", "sessionConfig", "status", "revision"})
    if not value:
        raise HTTPException(400, "No routine changes supplied.")
    routine = await _routine(routine_id)
    if "name" in value:
        value["name"] = _text(value["name"], "routine name", maximum=160)
    if "prompt" in value:
        value["prompt"] = _text(value["prompt"], "routine prompt", maximum=100_000)
    value.setdefault("revision", routine.get("revision"))
    return await _call("routines.update", {"routineId": routine_id, **value}, mutation=True)


@router.delete("/routines/{routine_id}")
async def delete_routine(routine_id: str):
    routine = await _routine(routine_id)
    return await _call("routines.delete", {
        "routineId": routine_id,
        "revision": routine.get("revision"),
    }, mutation=True)


@router.get("/routines/{routine_id}/history")
async def routine_history(routine_id: str, offset: int = 0, limit: int = 50):
    if offset < 0 or limit < 1 or limit > 100:
        raise HTTPException(400, "Invalid history page.")
    return await _call("sessions.listPreviewItems", {
        "routineId": _text(routine_id, "routine ID", maximum=160),
        "parent": "all",
        "archived": "include",
        "ephemeral": "include",
        "pinnedFirst": False,
        "offset": offset,
        "limit": limit,
    })


@router.post("/routines/{routine_id}/run")
async def run_routine(routine_id: str):
    return await _call("routines.runNow", {"routineId": routine_id}, mutation=True)


async def _set_routine_status(routine_id: str, status: str):
    routine = await _routine(routine_id)
    return await _call("routines.update", {
        "routineId": routine_id,
        "revision": routine.get("revision"),
        "status": status,
    }, mutation=True)


@router.post("/routines/{routine_id}/pause")
async def pause_routine(routine_id: str):
    return await _set_routine_status(routine_id, "paused")


@router.post("/routines/{routine_id}/resume")
async def resume_routine(routine_id: str):
    return await _set_routine_status(routine_id, "active")


@router.get("/memories")
async def memories():
    settings, files = await asyncio.gather(_settings(), _call("memory.listFiles"))
    return {"preferences": settings.get("memory", {}), "files": files}


@router.patch("/memories/preferences")
async def update_memory_preferences(payload: dict):
    value = _input(payload, {"enabled", "episodicRetentionDays", "dreamingMinHours", "dreamingMinSessions"})
    current = (await _settings()).get("memory", {})
    updated = {**current, **value}
    return await _call("settings.set", {"key": "memory", "value": updated}, mutation=True)


@router.get("/memories/file")
async def read_memory_file(path: str):
    return await _call("memory.readFile", {"filePath": _text(path, "memory path", maximum=4096)})


@router.patch("/memories/file")
async def write_memory_file(payload: dict):
    value = _input(payload, {"path", "content"}, required={"path", "content"})
    if not isinstance(value["content"], str) or len(value["content"]) > 2_000_000:
        raise HTTPException(400, "Invalid memory content.")
    return await _call("memory.writeFile", {
        "filePath": _text(value["path"], "memory path", maximum=4096),
        "content": value["content"],
    }, mutation=True)


@router.get("/context-awareness")
async def context_awareness():
    settings, status, applications = await asyncio.gather(
        _settings(),
        _call("contextAwareness.historyStatus"),
        _call("contextAwareness.listApplications"),
    )
    return {
        "settings": settings.get("contextAwareness", {}),
        "status": status,
        "applications": applications,
    }


@router.patch("/context-awareness")
async def update_context_awareness(payload: dict):
    value = _input(payload, {
        "enabled", "captureTypedText", "pausedUntil", "retentionDays", "rules", "screenOcr",
    })
    current = (await _settings()).get("contextAwareness", {})
    updated = {**current, **value}
    return await _call("settings.set", {"key": "contextAwareness", "value": updated}, mutation=True)


@router.get("/context-awareness/history")
async def context_history(from_ms: int = Query(alias="from"), to_ms: int = Query(alias="to")):
    if from_ms < 0 or to_ms <= from_ms or to_ms - from_ms > 31 * 24 * 60 * 60 * 1000:
        raise HTTPException(400, "Invalid Context Awareness history range.")
    return await _call("contextAwareness.historyList", {"from": from_ms, "to": to_ms})


@router.delete("/context-awareness/history")
async def clear_context_history(payload: dict):
    value = _input(payload, {"target"}, required={"target"})
    target = value["target"]
    if not isinstance(target, dict) or target.get("kind") not in {"all", "today", "timeRange"}:
        raise HTTPException(400, "Invalid history selection.")
    if target["kind"] == "timeRange" and not {
        "from", "to"
    }.issubset(target):
        raise HTTPException(400, "Invalid history range.")
    return await _call("contextAwareness.clear", {"target": target}, mutation=True)


@router.get("/skills")
async def list_skills(project_id: str | None = Query(default=None)):
    return await _call("projects.listSkillsForSettings", {"projectId": project_id})


def _skill_is_hidden(skill: dict) -> bool:
    metadata = skill.get("metadata") if isinstance(skill.get("metadata"), dict) else {}
    nested_metadata = metadata.get("metadata") if isinstance(metadata.get("metadata"), dict) else {}
    return (
        skill.get("group") == "builtin-site-specific"
        or bool(metadata.get("settingsGate"))
        or bool(nested_metadata.get("internal"))
        or str(skill.get("name", "")).lower() in SKILL_HIDDEN_NAMES
    )


@router.get("/skills/catalog")
async def skill_catalog(project_id: str | None = Query(default=None)):
    skills = await _call("projects.listSkillsForSettings", {"projectId": project_id})
    visible = [skill for skill in skills if skill.get("group") == "user" or not _skill_is_hidden(skill)]
    groups = {"personal": [], "builtin": [], "system": [], "passwordManager": []}
    for skill in visible:
        name = str(skill.get("name", "")).lower()
        root_name = str(skill.get("path", "")).replace("\\", "/").split("/")[1:2]
        builtin_name = root_name[0].lower() if root_name else name
        if skill.get("group") == "user":
            groups["personal"].append(skill)
        elif name in SKILL_PASSWORD_MANAGER_NAMES:
            groups["passwordManager"].append(skill)
        elif builtin_name in SKILL_SYSTEM_NAMES:
            groups["system"].append(skill)
        else:
            groups["builtin"].append(skill)
    return {"groups": groups, "skills": visible}


async def _skill(skill_path: str, project_id: str | None) -> dict:
    skills = await _call("projects.listSkillsForSettings", {"projectId": project_id})
    skill = next((item for item in skills if item.get("path") == skill_path), None)
    if not isinstance(skill, dict):
        raise HTTPException(404, "Skill not found.")
    return skill


@router.get("/skills/{skill_path:path}")
async def get_skill(skill_path: str, project_id: str | None = Query(default=None)):
    skill = await _skill(skill_path, project_id)
    definition_path = skill.get("definitionPath")
    if not isinstance(definition_path, str) or not definition_path:
        raise HTTPException(404, "Skill definition not found.")
    definition = await _call("projects.readSkillFile", {
        "projectId": project_id,
        "skillPath": definition_path,
    })
    if not isinstance(definition, dict) or not isinstance(definition.get("content"), str):
        raise HTTPException(502, "Aside returned an invalid skill definition.")
    metadata = definition.get("metadata")
    if not isinstance(metadata, dict):
        metadata = skill.get("metadata") if isinstance(skill.get("metadata"), dict) else {}
    return {
        **skill,
        **definition,
        "metadata": metadata,
        "agents": metadata.get("agents", ["aside"]),
        "body": SKILL_FRONTMATTER.sub("", definition["content"]).lstrip(),
    }


@router.post("/skills")
async def create_skill(payload: dict):
    value = _input(payload, {
        "projectId", "name", "description", "body", "enabled", "keywords", "urlPatterns",
    }, required={"name", "description", "body"})
    value.setdefault("projectId", None)
    value.setdefault("enabled", True)
    value.setdefault("keywords", [])
    value.setdefault("urlPatterns", [])
    return await _call("projects.createSkill", value, mutation=True)


@router.post("/skills/import")
async def import_skill(payload: dict):
    value = _input(payload, {"projectId", "sourcePath"}, required={"sourcePath"})
    return await _call("projects.importSkillFolder", {
        "projectId": value.get("projectId"),
        "sourcePath": _text(value["sourcePath"], "skill folder", maximum=4096),
    }, mutation=True)


@router.post("/skills/{skill_path:path}/copy")
async def copy_skill_for_customization(skill_path: str, payload: dict):
    value = _input(payload, {"projectId"})
    return await _call("projects.copySkillForCustomization", {
        "projectId": value.get("projectId"),
        "skillPath": skill_path,
    }, mutation=True)


@router.patch("/skills/{skill_path:path}")
async def update_skill(skill_path: str, payload: dict):
    value = _input(payload, {
        "projectId", "name", "description", "body", "enabled", "keywords", "urlPatterns", "agents",
    })
    project_id = value.pop("projectId", None)
    if not value:
        raise HTTPException(400, "No skill changes supplied.")
    if set(value) == {"enabled"}:
        return await _call("projects.setSkillEnabled", {
            "projectId": project_id,
            "skillPath": skill_path,
            "enabled": value["enabled"],
        }, mutation=True)
    if set(value) == {"agents"}:
        return await _call("projects.setSkillAgents", {
            "projectId": project_id,
            "skillPath": skill_path,
            "agents": value["agents"],
        }, mutation=True)
    current = await _skill(skill_path, project_id)
    auto_inject = current.get("metadata", {}).get("autoInject", {})
    value.setdefault("keywords", auto_inject.get("keywords", []))
    value.setdefault("urlPatterns", auto_inject.get("url", []))
    required = {"name", "description", "body", "enabled", "keywords", "urlPatterns"}
    if set(value) != required:
        raise HTTPException(400, "Editing a skill requires its complete definition.")
    return await _call("projects.updateSkill", {
        "projectId": project_id,
        "skillPath": skill_path,
        **value,
    }, mutation=True)


@router.delete("/skills/{skill_path:path}")
async def delete_skill(skill_path: str, project_id: str | None = Query(default=None)):
    return await _call("projects.deleteSkill", {
        "projectId": project_id,
        "skillPath": skill_path,
    }, mutation=True)


def _connection_list(servers: object) -> list[dict]:
    if not isinstance(servers, dict):
        return []
    return [{"name": name, **server} for name, server in servers.items() if isinstance(server, dict)]


def _tool_inventory(mcp: object) -> list[dict]:
    if not isinstance(mcp, dict) or not isinstance(mcp.get("inventories"), dict):
        return []
    tools = []
    for server_name, inventory in mcp["inventories"].items():
        if not isinstance(inventory, dict) or not isinstance(inventory.get("tools"), list):
            continue
        for tool in inventory["tools"]:
            if isinstance(tool, dict):
                tools.append({"server": server_name, **tool})
    return tools


@router.get("/connections/tools/permissions")
async def tool_permissions():
    settings = await _settings()
    permission = settings.get("permission") if isinstance(settings.get("permission"), dict) else {}
    rules = permission.get("rules") if isinstance(permission.get("rules"), dict) else {}
    return {"rules": rules, "tools": _tool_inventory(settings.get("mcp"))}


@router.patch("/connections/tools/permissions")
async def update_tool_permission(payload: dict):
    value = _input(payload, {"tool", "policy"}, required={"tool", "policy"})
    tool = _text(value["tool"], "tool name", maximum=512)
    policy = value["policy"]
    if not isinstance(policy, str) or policy not in {"allow", "ask", "deny", "inherit"}:
        raise HTTPException(400, "Invalid tool permission policy.")
    settings = await _settings()
    current = settings.get("permission") if isinstance(settings.get("permission"), dict) else {}
    current_rules = current.get("rules") if isinstance(current.get("rules"), dict) else {}
    rules = {}
    for group in ("allow", "ask", "deny"):
        items = current_rules.get(group) if isinstance(current_rules.get(group), list) else []
        rules[group] = [
            item for item in items
            if not (isinstance(item, dict) and item.get("type") == "tool" and item.get("tool") == tool)
        ]
    if policy != "inherit":
        rules[policy].append({"type": "tool", "tool": tool})
    rules["default"] = current_rules.get("default", "allow")
    updated = {
        **current,
        "rules": {**current_rules, **rules},
    }
    return await _call("settings.set", {"key": "permission", "value": updated}, mutation=True)


@router.get("/connections")
async def connections():
    mcp = (await _settings()).get("mcp", {})
    return {
        "servers": _connection_list(mcp.get("servers", {})),
        "inventories": mcp.get("inventories", {}),
    }


@router.post("/connections")
async def create_connection(payload: dict):
    value = _input(payload, {"name", "server", "clientSecret"}, required={"name", "server"})
    name = _text(value["name"], "connection name", maximum=64)
    response = await _call("mcp.saveServer", {
        "name": name,
        "server": value["server"],
        **({"clientSecret": value["clientSecret"]} if value.get("clientSecret") else {}),
    }, mutation=True)
    return {"ok": True, "connection": _redact(response)}


@router.get("/connections/{name}")
async def get_connection(name: str):
    mcp = (await _settings()).get("mcp", {})
    servers = mcp.get("servers", {}) if isinstance(mcp, dict) else {}
    server = servers.get(name) if isinstance(servers, dict) else None
    if not isinstance(server, dict):
        raise HTTPException(404, "Connection not found.")
    connection = None
    if server.get("enabled") and server.get("transport") == "streamable-http":
        connection = await _call("mcp.connectionStatus", {"name": name})
    inventories = mcp.get("inventories", {}) if isinstance(mcp, dict) else {}
    inventory = inventories.get(name) if isinstance(inventories, dict) else None
    return {"server": {"name": name, **server}, "inventory": inventory, "connection": connection}


@router.patch("/connections/{name}")
async def update_connection(name: str, payload: dict):
    value = _input(payload, {"name", "server", "clientSecret", "enabled"})
    if set(value) == {"enabled"}:
        return await _call("mcp.setEnabled", {"name": name, "enabled": value["enabled"]}, mutation=True)
    new_name = _text(value.get("name", name), "connection name", maximum=64)
    if "server" not in value:
        raise HTTPException(400, "Missing required field: server")
    response = await _call("mcp.saveServer", {
        "previousName": name,
        "name": new_name,
        "server": value["server"],
        **({"clientSecret": value["clientSecret"]} if value.get("clientSecret") else {}),
    }, mutation=True)
    return {"ok": True, "connection": _redact(response)}


@router.delete("/connections/{name}")
async def delete_connection(name: str):
    return await _call("mcp.deleteServer", {"name": name}, mutation=True)


@router.post("/connections/{name}/{action}")
async def connection_action(name: str, action: str):
    procedures = {
        "test": "mcp.testConnection",
        "connect": "mcp.connect",
        "cancel": "mcp.cancel",
        "refresh": "mcp.refreshTools",
    }
    if action not in procedures:
        raise HTTPException(404, "Unknown connection action.")
    return await _call(procedures[action], {"name": name}, mutation=True)


@router.get("/providers")
async def providers():
    return await _call("models.listSettingsInventory")


@router.get("/providers/custom/{provider_id}")
async def custom_provider(provider_id: str):
    return await _call("models.getCustomProviderConfig", {"providerId": provider_id})


@router.post("/providers/custom")
async def save_custom_provider(payload: dict):
    value = _input(payload, {"providers"}, required={"providers"})
    if not isinstance(value["providers"], dict) or not value["providers"]:
        raise HTTPException(400, "Invalid custom provider configuration.")
    await _call("models.setCustomProvidersConfig", value, mutation=True)
    return {"ok": True}


@router.delete("/providers/custom/{provider_id}")
async def delete_custom_provider(provider_id: str):
    await _call("models.removeCustomProviderConfig", {"providerId": provider_id}, mutation=True)
    return {"ok": True}


@router.post("/providers/{provider_id}/credential")
async def set_provider_credential(provider_id: str, payload: dict):
    value = _input(payload, {"credential"}, required={"credential"})
    if not isinstance(value["credential"], dict):
        raise HTTPException(400, "Invalid credential.")
    await _call("models.setCredential", {
        "providerId": provider_id,
        "credential": value["credential"],
    }, mutation=True)
    return {"ok": True}


@router.delete("/providers/{provider_id}/credential")
async def remove_provider_credential(provider_id: str):
    await _call("models.removeCredential", {"providerId": provider_id}, mutation=True)
    return {"ok": True}


@router.get("/account")
async def account():
    profile, devices = await asyncio.gather(
        _call("accounts.get"),
        _call("accounts.auth.devices"),
    )
    return {"profile": profile, "devices": devices}


@router.patch("/account/profile")
async def update_account_profile(payload: dict):
    value = _input(payload, {"name"}, required={"name"})
    return await _call("accounts.auth.updateProfile", {
        "name": _text(value["name"], "profile name", maximum=120),
    }, mutation=True)


@router.post("/account/devices/{device_id}/sign-out")
async def sign_out_device(device_id: str):
    devices = await _call("accounts.auth.devices")
    device = next((item for item in devices if item.get("id") == device_id), None)
    if device is None:
        raise HTTPException(404, "Device not found.")
    if device.get("isCurrent"):
        raise HTTPException(409, "The current device must be signed out from Aside.")
    return await _call("accounts.auth.signOutDevice", {"deviceId": device_id}, mutation=True)


@router.get("/preferences")
async def preferences():
    settings = await _settings()
    return {key: settings.get(key) for key in PREFERENCE_KEYS}


@router.patch("/preferences")
async def update_preferences(payload: dict):
    value = _input(payload, PREFERENCE_KEYS)
    if not value:
        raise HTTPException(400, "No preference changes supplied.")
    async with PREFERENCE_WRITE_LOCK:
        current = await _settings()
        previous = {key: current.get(key) for key in value}
        applied = []
        results = {}
        try:
            for key, item in value.items():
                results[key] = await _call(
                    "settings.set", {"key": key, "value": item}, mutation=True,
                )
                applied.append(key)
        except HTTPException:
            rollback_failures = []
            for key in reversed(applied):
                try:
                    await _call(
                        "settings.set", {"key": key, "value": previous[key]}, mutation=True,
                    )
                except HTTPException:
                    rollback_failures.append(key)
            if rollback_failures:
                raise HTTPException(
                    409,
                    "Some settings may have changed because rollback failed. Refresh settings before editing again.",
                ) from None
            raise
        return {"updated": list(value), "settings": results}

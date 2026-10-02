// ==UserScript==
// @name         Tencent Meeting Local Export
// @namespace    local.tencent-meeting-export
// @version      0.1.0
// @description  Export the current Tencent Meeting public-share transcript and minutes locally.
// @match        https://meeting.tencent.com/cw/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  /*
   * These paths and response shapes are the current Web API used by
   * Tencent Meeting's public share page. They are not a versioned public
   * SDK; Tencent may change them when the page is updated. The parser is
   * intentionally strict so a schema change is reported as incomplete.
   */
  const MINUTES_DETAIL_PATH = "/wemeet-cloudrecording-webapi/v1/minutes/detail";
  const SUMMARY_PATH = "/wemeet-tapi/v2/meetlog/public/record-detail/get-mul-summary-and-todo";
  const MINUTES_PAGE_LIMIT = 20;

  class ApiError extends Error {
    constructor(message) {
      super(message);
      this.name = "ApiError";
    }
  }

  function errorMessage(error) {
    if (error instanceof Error && error.message) return error.message;
    return String(error || "未知错误");
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function embeddedMarker(html, key) {
    const pattern = new RegExp(escapeRegExp(key) + "\\\\?\\\"\\s*:\\s*");
    return pattern.exec(html);
  }

  function normalizeEmbeddedJson(source) {
    return String(source)
      .replace(/\\\\u/g, "\\u")
      .replace(/\\\"/g, '"');
  }

  function objectEnd(source, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
    }
    return -1;
  }

  function extractEmbeddedObject(html, key) {
    if (typeof html !== "string") throw new ApiError("分享页内容不是文本");
    const marker = embeddedMarker(html, key);
    if (!marker) throw new ApiError(`分享页缺少 ${key} 数据`);
    const rawStart = html.indexOf("{", marker.index + marker[0].length);
    if (rawStart < 0) throw new ApiError(`分享页 ${key} 数据格式无效`);

    const normalized = normalizeEmbeddedJson(html.slice(rawStart));
    const normalizedEnd = objectEnd(normalized, 0);
    if (normalizedEnd < 0) throw new ApiError(`分享页 ${key} JSON 无法解析`);
    try {
      const value = JSON.parse(normalized.slice(0, normalizedEnd));
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("not an object");
      }
      return value;
    } catch (error) {
      throw new ApiError(`分享页 ${key} JSON 无法解析: ${errorMessage(error)}`);
    }
  }

  function extractEmbeddedString(html, key) {
    const marker = embeddedMarker(html, key);
    if (!marker) return null;
    const tail = html.slice(marker.index + marker[0].length);
    const normalized = normalizeEmbeddedJson(tail);
    const start = normalized.indexOf('"');
    if (start < 0) return null;
    let escaped = false;
    for (let index = start + 1; index < normalized.length; index += 1) {
      const char = normalized[index];
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        try {
          return JSON.parse(normalized.slice(start, index + 1));
        } catch (_) {
          return normalized.slice(start + 1, index);
        }
      }
    }
    return null;
  }

  function decodeSubject(value) {
    if (typeof value !== "string" || !value) return "未命名会议";
    try {
      if (typeof atob !== "function") return value;
      const binary = atob(value);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      const decoded = typeof TextDecoder === "function"
        ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        : decodeURIComponent(escape(binary));
      if (decoded && /[^\x00-\x7f]/.test(decoded)) return decoded;
    } catch (_) {
      // The subject may already be plain text; retain it on decode failure.
    }
    return value;
  }

  function asInteger(value, fieldName) {
    if (typeof value === "number") {
      if (Number.isSafeInteger(value)) return value;
    } else if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed)) return parsed;
    }
    throw new ApiError(`字段 ${fieldName} 不是整数`);
  }

  function optionalInteger(value, fieldName) {
    if (value === undefined || value === null || value === "") return null;
    return asInteger(value, fieldName);
  }

  function shareIdFromValue(value) {
    if (typeof value !== "string" || !value) return "";
    const candidates = [value, value.startsWith("?") ? value : `?${value}`];
    for (const candidate of candidates) {
      try {
        const parsed = new URL(candidate, "https://meeting.tencent.com");
        const id = parsed.searchParams.get("id");
        if (id) return id;
      } catch (_) {
        // Try the next representation.
      }
    }
    const match = /(?:^|[?&])id=([^&#]+)/.exec(value);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function parseSharePage(html, sourceUrl) {
    const serverData = extractEmbeddedObject(html, "serverData");
    if (serverData.code !== 0 && serverData.code !== "0") {
      throw new ApiError(`分享页返回业务错误: ${serverData.code}`);
    }
    const meetingInfo = serverData.meeting_info;
    const recordings = serverData.recordings;
    if (!meetingInfo || typeof meetingInfo !== "object" || Array.isArray(meetingInfo) ||
        !Array.isArray(recordings) || recordings.length === 0) {
      throw new ApiError("分享页缺少 meeting_info 或 recordings");
    }
    const recording = recordings[0];
    if (!recording || typeof recording !== "object" || Array.isArray(recording)) {
      throw new ApiError("分享页 recordings schema 无效");
    }
    const meetingId = String(meetingInfo.meeting_id || serverData.meeting_id || "");
    const recordingId = String(recording.id || "");
    if (!meetingId || !recordingId) throw new ApiError("分享页缺少 meeting_id 或 recording_id");

    const startValue = meetingInfo.start_time ?? recording.start_time;
    const startedAtMs = asInteger(startValue, "start_time");
    const durationValue = serverData.total_recording_duration ?? recording.duration;
    const durationMs = optionalInteger(durationValue, "duration");
    const longUrlInfo = serverData.short_url_info;
    const longUrl = longUrlInfo && typeof longUrlInfo === "object"
      ? longUrlInfo.long_url
      : extractEmbeddedString(html, "fullLongUrlSearch");

    return {
      subject: decodeSubject(meetingInfo.subject || serverData.subject),
      startedAtMs,
      durationMs,
      meetingId,
      recordingId,
      shareId: shareIdFromValue(longUrl),
      sourceUrl: sourceUrl || ""
    };
  }

  function speakerName(paragraph) {
    const speaker = paragraph && paragraph.speaker;
    if (speaker && typeof speaker === "object") {
      return String(speaker.user_name || speaker.nick_name || speaker.name || "未知发言人");
    }
    return "未知发言人";
  }

  function joinWords(words) {
    if (!Array.isArray(words)) throw new ApiError("逐字稿 sentence 缺少 words/text");
    const pieces = words.map((word) => {
      if (typeof word === "string") return word;
      if (word && typeof word === "object" && typeof word.text === "string") return word.text;
      throw new ApiError("逐字稿 word schema 无效");
    });
    let result = "";
    for (const piece of pieces) {
      if (result && /[A-Za-z0-9]$/.test(result) && /^[A-Za-z0-9]/.test(piece)) result += " ";
      result += piece;
    }
    return result;
  }

  function sentenceText(sentence) {
    if (!sentence || typeof sentence !== "object" || Array.isArray(sentence)) {
      throw new ApiError("逐字稿 sentence schema 无效");
    }
    if (typeof sentence.text === "string") return sentence.text;
    return joinWords(sentence.words);
  }

  function flattenParagraphs(paragraphs) {
    if (!Array.isArray(paragraphs)) throw new ApiError("逐字稿 paragraphs 不是数组");
    const entries = [];
    paragraphs.forEach((paragraph, paragraphIndex) => {
      if (!paragraph || typeof paragraph !== "object" || Array.isArray(paragraph)) {
        throw new ApiError(`逐字稿 paragraph ${paragraphIndex} schema 无效`);
      }
      const pid = paragraph.pid;
      if (pid === undefined || pid === null || pid === "") {
        throw new ApiError("逐字稿 paragraph schema 无效");
      }
      if (!Array.isArray(paragraph.sentences)) {
        throw new ApiError(`paragraph ${pid} 缺少 sentences`);
      }
      const speaker = speakerName(paragraph);
      paragraph.sentences.forEach((sentence, sentenceIndex) => {
        const startValue = sentence && typeof sentence === "object"
          ? (sentence.start_time ?? paragraph.start_time)
          : undefined;
        const startOffsetMs = asInteger(startValue, "sentence.start_time");
        let endOffsetMs = null;
        if (sentence && typeof sentence === "object") {
          const endValue = sentence.end_time ?? paragraph.end_time;
          if (endValue !== undefined && endValue !== null && endValue !== "") {
            endOffsetMs = asInteger(endValue, "sentence.end_time");
          }
        }
        entries.push({
          paragraphId: String(pid),
          sentenceId: String(sentence && sentence.sid !== undefined ? sentence.sid : sentenceIndex),
          speaker,
          text: sentenceText(sentence),
          startOffsetMs,
          endOffsetMs
        });
      });
    });
    return entries;
  }

  function parseMinutesPage(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ApiError("逐字稿接口响应不是对象");
    }
    if (raw.code !== 0) {
      throw new ApiError(`逐字稿接口业务错误: ${raw.code} ${raw.msg || ""}`.trim());
    }
    if (!raw.minutes || typeof raw.minutes !== "object" || !Array.isArray(raw.minutes.paragraphs)) {
      throw new ApiError("逐字稿接口缺少 minutes.paragraphs");
    }
    if (typeof raw.more !== "boolean") {
      throw new ApiError("逐字稿分页响应缺少布尔 more 字段");
    }
    for (const paragraph of raw.minutes.paragraphs) {
      if (!paragraph || typeof paragraph !== "object" || paragraph.pid === undefined || paragraph.pid === null || paragraph.pid === "") {
        throw new ApiError("逐字稿 paragraph schema 无效");
      }
    }
    return { paragraphs: raw.minutes.paragraphs, more: raw.more };
  }

  function mergeParagraph(existing, incoming) {
    if (!existing) return incoming;
    if (!Array.isArray(existing.sentences) || !Array.isArray(incoming.sentences)) return incoming;
    const byId = new Map();
    const merged = [];
    const add = (sentence, index) => {
      const key = sentence && sentence.sid !== undefined ? String(sentence.sid) : `index:${index}`;
      if (!byId.has(key)) {
        byId.set(key, merged.length);
        merged.push(sentence);
      } else {
        merged[byId.get(key)] = sentence;
      }
    };
    existing.sentences.forEach(add);
    incoming.sentences.forEach(add);
    return Object.assign({}, existing, incoming, { sentences: merged });
  }

  function makeMinutesResult(complete, pagesRequested, paragraphsById, rawPages, error) {
    const paragraphs = Array.from(paragraphsById.values());
    let entries = [];
    let flattenError = null;
    try {
      entries = flattenParagraphs(paragraphs);
    } catch (caught) {
      flattenError = errorMessage(caught);
    }
    const finalError = error || flattenError;
    return {
      complete: Boolean(complete && !finalError),
      pagesRequested,
      paragraphCount: paragraphs.length,
      sentenceCount: paragraphs.reduce((total, paragraph) => total + (Array.isArray(paragraph.sentences) ? paragraph.sentences.length : 0), 0),
      entryCount: entries.length,
      entries,
      firstOffsetMs: entries.length ? entries[0].startOffsetMs : null,
      lastOffsetMs: entries.length ? entries[entries.length - 1].startOffsetMs : null,
      rawPages,
      error: finalError || null
    };
  }

  async function fetchMinutes(meta, requestJson) {
    if (typeof requestJson !== "function") throw new ApiError("缺少逐字稿请求函数");
    const params = {
      meeting_id: meta.meetingId,
      recording_id: meta.recordingId,
      share_id: "",
      is_single: "true",
      is_meetlog: "false",
      short_url_code: "",
      lang: "zh",
      minutes_version: "1",
      limit: String(MINUTES_PAGE_LIMIT),
      return_ori: "0",
      return_ori_minutes_translating: "1"
    };
    let pagesRequested = 0;
    const rawPages = [];
    const paragraphsById = new Map();
    const seenCursors = new Set();
    let previousCursor = null;

    while (true) {
      pagesRequested += 1;
      let raw;
      try {
        raw = await requestJson(MINUTES_DETAIL_PATH, { method: "GET", params: Object.assign({}, params) });
      } catch (error) {
        return makeMinutesResult(false, pagesRequested, paragraphsById, rawPages, errorMessage(error));
      }
      if (raw && typeof raw === "object" && !Array.isArray(raw)) rawPages.push(raw);
      let parsed;
      try {
        parsed = parseMinutesPage(raw);
      } catch (error) {
        return makeMinutesResult(false, pagesRequested, paragraphsById, rawPages, errorMessage(error));
      }
      for (const paragraph of parsed.paragraphs) {
        const key = String(paragraph.pid);
        paragraphsById.set(key, mergeParagraph(paragraphsById.get(key), paragraph));
      }
      if (parsed.more === false) {
        return makeMinutesResult(true, pagesRequested, paragraphsById, rawPages, null);
      }
      if (parsed.paragraphs.length === 0) {
        return makeMinutesResult(false, pagesRequested, paragraphsById, rawPages, "逐字稿 more=true 但当前页没有 paragraph，无法推进游标");
      }
      const nextCursor = String(parsed.paragraphs[parsed.paragraphs.length - 1].pid);
      const numericNext = /^-?\d+$/.test(nextCursor) ? Number(nextCursor) : null;
      const numericPrevious = previousCursor !== null && /^-?\d+$/.test(previousCursor) ? Number(previousCursor) : null;
      if (seenCursors.has(nextCursor) || (numericNext !== null && numericPrevious !== null && numericNext <= numericPrevious)) {
        return makeMinutesResult(false, pagesRequested, paragraphsById, rawPages, `逐字稿分页 cursor 未推进: ${nextCursor}`);
      }
      seenCursors.add(nextCursor);
      previousCursor = nextCursor;
      params.pid = nextCursor;
    }
  }

  async function fetchSummary(meta, requestJson) {
    if (typeof requestJson !== "function") throw new ApiError("缺少纪要请求函数");
    const payload = {
      record_id: meta.recordingId,
      pwd: "",
      activity_uid: "",
      meeting_id: meta.meetingId,
      lang: "zh",
      share_id: meta.shareId || "",
      summary_type: 0
    };
    let raw;
    try {
      raw = await requestJson(SUMMARY_PATH, { method: "POST", json: payload });
    } catch (error) {
      return { complete: false, chapterCount: 0, todoCount: 0, chapters: [], todos: [], summaryHtml: "", rawResponse: null, error: errorMessage(error) };
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { complete: false, chapterCount: 0, todoCount: 0, chapters: [], todos: [], summaryHtml: "", rawResponse: null, error: "纪要接口响应不是对象" };
    }
    if (raw.code !== 0) {
      return { complete: false, chapterCount: 0, todoCount: 0, chapters: [], todos: [], summaryHtml: "", rawResponse: raw, error: `纪要接口业务错误: ${raw.code} ${raw.msg || ""}`.trim() };
    }
    const data = raw.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { complete: false, chapterCount: 0, todoCount: 0, chapters: [], todos: [], summaryHtml: "", rawResponse: raw, error: "纪要接口缺少 data" };
    }
    const chapterSummary = data.chapter_summary;
    const todo = data.todo;
    const chapters = chapterSummary && typeof chapterSummary === "object" && Array.isArray(chapterSummary.summary_list)
      ? chapterSummary.summary_list : [];
    const todos = todo && typeof todo === "object" && Array.isArray(todo.todo_list) ? todo.todo_list : [];
    if (chapters.some((item) => !item || typeof item !== "object") || todos.some((item) => !item || typeof item !== "object")) {
      return { complete: false, chapterCount: 0, todoCount: 0, chapters: [], todos: [], summaryHtml: "", rawResponse: raw, error: "纪要接口 summary/todo schema 无效" };
    }
    const deepseek = data.deepseek_summary;
    const summaryHtml = deepseek && typeof deepseek === "object"
      ? String(deepseek.orig_custom_summary || deepseek.custom_summary || "")
      : "";
    return {
      complete: true,
      chapterCount: chapters.length,
      todoCount: todos.length,
      chapters,
      todos,
      summaryHtml,
      rawResponse: raw,
      error: null
    };
  }

  const DEFAULT_TURN_MERGE_GAP_MS = 30000;

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function formatClock(milliseconds) {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60);
    if (hours > 0) return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
    return `${pad2(totalMinutes)}:${pad2(seconds)}`;
  }

  function formatOffset(offsetMs) {
    if (offsetMs === null || offsetMs === undefined || !Number.isFinite(Number(offsetMs))) return "未提供";
    return formatClock(Number(offsetMs));
  }

  function formatDuration(durationMs) {
    if (durationMs === null || durationMs === undefined || !Number.isFinite(Number(durationMs))) return "未提供";
    return formatClock(Math.round(Number(durationMs) / 1000) * 1000);
  }

  function safeFilename(value) {
    const cleaned = String(value || "")
      .replace(/[\x00-\x1f<>:"/\\|?*]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, "");
    return (cleaned || "未命名会议").slice(0, 120);
  }

  function mergeSpeakerTurns(entries, gapMs) {
    if (!Array.isArray(entries)) throw new ApiError("逐字稿 entries 不是数组");
    const gap = gapMs === undefined ? DEFAULT_TURN_MERGE_GAP_MS : Number(gapMs);
    if (!Number.isFinite(gap) || gap < 0) throw new ApiError("speaker turn 合并间隔无效");
    const turns = [];
    let current = null;
    let previousEntry = null;
    for (const entry of entries) {
      const canMerge = current && previousEntry &&
        current.speaker === entry.speaker &&
        previousEntry.endOffsetMs !== null && previousEntry.endOffsetMs !== undefined &&
        Number.isFinite(Number(previousEntry.endOffsetMs)) &&
        Number.isFinite(Number(entry.startOffsetMs)) &&
        Number(entry.startOffsetMs) - Number(previousEntry.endOffsetMs) <= gap;
      if (!canMerge) {
        current = {
          speaker: entry.speaker || "未知发言人",
          startOffsetMs: entry.startOffsetMs,
          endOffsetMs: entry.endOffsetMs,
          entries: [entry]
        };
        turns.push(current);
      } else {
        current.entries.push(entry);
        current.endOffsetMs = entry.endOffsetMs;
      }
      previousEntry = entry;
    }
    return turns;
  }

  function joinTurnTexts(texts) {
    if (!Array.isArray(texts)) throw new ApiError("speaker turn 文本不是数组");
    let result = "";
    for (const value of texts) {
      const piece = String(value || "");
      if (!result || !piece) {
        result += piece;
        continue;
      }
      const left = result.replace(/\s+$/g, "");
      const right = piece.replace(/^\s+/g, "");
      const hasBoundaryWhitespace = left.length !== result.length || right.length !== piece.length;
      if (!hasBoundaryWhitespace && /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right)) result += " ";
      result += piece;
    }
    return result;
  }

  function humanDate(startedAtMs) {
    if (startedAtMs === null || startedAtMs === undefined || !Number.isFinite(Number(startedAtMs))) return "未提供";
    try {
      return new Date(Number(startedAtMs)).toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      });
    } catch (_) {
      return new Date(Number(startedAtMs)).toISOString();
    }
  }

  function plainSummaryHtml(value) {
    if (!value) return "";
    let text = String(value)
      .replace(/<\s*(br|\/p|\/li|\/h[1-6])\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'");
    return text.split(/\r?\n/).map((line) => line.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n");
  }

  function itemValue(item, keys, fallback) {
    if (!item || typeof item !== "object") return fallback || "";
    for (const key of keys) {
      const value = item[key];
      if (value === null || value === undefined) continue;
      if (Array.isArray(value) || (typeof value === "object" && value !== null)) return JSON.stringify(value);
      if (String(value).trim()) return String(value).trim();
    }
    return fallback || "";
  }

  function todoAssignees(todo) {
    if (!todo || !Array.isArray(todo.persons)) return "";
    const names = todo.persons.map((person) => {
      if (person && typeof person === "object") return itemValue(person, ["name", "user_name", "nick_name"], "");
      return person ? String(person) : "";
    }).filter(Boolean);
    return names.length ? `（负责人：${names.join("、")}）` : "";
  }

  function renderMarkdown(meta, minutes, summary) {
    const transcriptEntries = minutes && Array.isArray(minutes.entries) ? minutes.entries : [];
    const summaryResult = summary || { complete: false, chapters: [], todos: [], summaryHtml: "", error: "未取得纪要" };
    const chapters = Array.isArray(summaryResult.chapters) ? summaryResult.chapters : [];
    const todos = Array.isArray(summaryResult.todos) ? summaryResult.todos : [];
    const speakers = [];
    for (const entry of transcriptEntries) {
      const speaker = entry.speaker || "未知发言人";
      if (!speakers.includes(speaker)) speakers.push(speaker);
    }
    const lines = [
      `# ${meta.subject || "未命名会议"}`,
      "",
      `- 开始时间：${humanDate(meta.startedAtMs)}`,
      `- 会议时长：${formatDuration(meta.durationMs)}`,
      `- 发言人：${speakers.length ? speakers.join("、") : "未提供"}`,
      "",
      "## AI 纪要",
      ""
    ];
    if (!summaryResult.complete) {
      lines.push(`> ⚠️ 纪要不完整：${summaryResult.error || "接口没有确认完整结束"}`, "");
    }
    if (chapters.length) {
      for (const chapter of chapters) {
        lines.push(`### ${itemValue(chapter, ["title", "name", "chapter_name"], "未命名主题")}`, "");
        lines.push(itemValue(chapter, ["summary", "content", "description", "text"], "（无内容）"), "");
      }
    } else {
      lines.push("（无结构化摘要）", "");
    }
    lines.push("### 摘要", "", plainSummaryHtml(summaryResult.summaryHtml) || "（无自由格式摘要）", "", "## 待办事项", "");
    if (todos.length) {
      for (const todo of todos) lines.push(`- [ ] ${itemValue(todo, ["todo_name", "name", "title", "content", "task"], "未命名待办")}${todoAssignees(todo)}`);
    } else {
      lines.push("（无待办）");
    }
    lines.push("", "## 完整逐字稿", "");
    if (!minutes || !minutes.complete) {
      lines.push(`> ⚠️ 逐字稿不完整：${(minutes && minutes.error) || "接口没有确认完整结束"}`, "");
    }
    if (!transcriptEntries.length) {
      lines.push("（没有可用逐字稿句子）", "");
    } else {
      const turns = mergeSpeakerTurns(transcriptEntries);
      for (const turn of turns) {
        lines.push(`### [${formatOffset(turn.startOffsetMs)}] ${turn.speaker}`, "");
      lines.push(joinTurnTexts(turn.entries.map((entry) => entry.text || "（空句子）")), "");
      }
    }
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }

  function sanitizeRawValue(value) {
    if (Array.isArray(value)) return value.map(sanitizeRawValue);
    if (!value || typeof value !== "object") return value;
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (/^(cookie|authorization|headers?|token|access_token|refresh_token|password|passwd|pwd)$/i.test(key)) continue;
      result[key] = sanitizeRawValue(child);
    }
    return result;
  }

  function buildRawPayload(input) {
    const metadata = input && input.metadata ? input.metadata : {};
    const minutes = input && input.minutes ? input.minutes : {};
    const summary = input && input.summary ? input.summary : {};
    return {
      metadata: sanitizeRawValue({
        subject: metadata.subject || "",
        startedAtMs: metadata.startedAtMs ?? null,
        durationMs: metadata.durationMs ?? null,
        meetingId: metadata.meetingId || "",
        recordingId: metadata.recordingId || "",
        shareId: metadata.shareId || "",
        sourceUrl: metadata.sourceUrl || ""
      }),
      minutes: sanitizeRawValue({
        complete: Boolean(minutes.complete),
        pagesRequested: minutes.pagesRequested || 0,
        paragraphCount: minutes.paragraphCount || 0,
        sentenceCount: minutes.sentenceCount || 0,
        entryCount: minutes.entryCount || 0,
        firstOffsetMs: minutes.firstOffsetMs ?? null,
        lastOffsetMs: minutes.lastOffsetMs ?? null,
        rawPages: Array.isArray(minutes.rawPages) ? minutes.rawPages : []
      }),
      summary: sanitizeRawValue({
        complete: Boolean(summary.complete),
        chapterCount: summary.chapterCount || 0,
        todoCount: summary.todoCount || 0,
        chapters: Array.isArray(summary.chapters) ? summary.chapters : [],
        todos: Array.isArray(summary.todos) ? summary.todos : [],
        summaryHtml: summary.summaryHtml || "",
        rawResponse: summary.rawResponse || null
      })
    };
  }

  const USERSCRIPT_METADATA = [
    "// ==UserScript==",
    "// @match        https://meeting.tencent.com/cw/*",
    "// @grant        none",
    "// @run-at       document-idle",
    "// ==/UserScript=="
  ].join("\\n");

  const UI_TEXT = Object.freeze({
    exportButton: "导出会议",
    rawOption: "同时保存 Raw JSON",
    detailButton: "查看导出详情",
    summaryOption: "导出 AI 纪要和待办",
    transcriptOption: "导出完整逐字稿",
    separateOption: "分别保存纪要与逐字稿",
    exportAction: "开始导出",
    closeAction: "关闭",
    loading: "正在读取会议数据…"
  });

  function buildFetchOptions(method, body) {
    const upperMethod = String(method || "GET").toUpperCase();
    const headers = { Accept: "application/json" };
    const options = { method: upperMethod, credentials: "same-origin", headers };
    if (upperMethod !== "GET" && body !== undefined) {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    return options;
  }

  async function requestJson(path, options) {
    if (typeof fetch !== "function") throw new ApiError("当前浏览器不支持 fetch");
    const config = options || {};
    const method = String(config.method || "GET").toUpperCase();
    const url = new URL(path, location.origin);
    if (method === "GET" && config.params) {
      for (const [key, value] of Object.entries(config.params)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }
    url.searchParams.set("c_lang", "zh-CN");
    const response = await fetch(url.href, buildFetchOptions(method, method === "GET" ? undefined : config.json));
    if (!response.ok) throw new ApiError(`腾讯接口 HTTP ${response.status}: ${path}`);
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new ApiError(`腾讯接口返回的不是 JSON: ${path}: ${errorMessage(error)}`);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ApiError(`腾讯接口响应 schema 无效: ${path}`);
    }
    return payload;
  }

  function ensureExportButton(container, onClick) {
    const root = container || (typeof document !== "undefined" ? document.body : null);
    if (!root) throw new ApiError("页面尚未准备好");
    let button = root.querySelector ? root.querySelector("button[data-tme-export]") : null;
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.dataset.tmeExport = "1";
      button.textContent = UI_TEXT.exportButton;
      button.setAttribute("aria-label", UI_TEXT.exportButton);
      button.style.cssText = [
        "position:fixed", "right:24px", "top:80px", "z-index:2147483000",
        "border:0", "border-radius:8px", "padding:10px 16px", "background:#1677ff",
        "color:#fff", "font-size:14px", "cursor:pointer", "box-shadow:0 3px 12px rgba(0,0,0,.2)"
      ].join(";");
      button.addEventListener("click", () => {
        if (typeof button.__tmeOnClick === "function") button.__tmeOnClick();
      });
      root.appendChild(button);
    }
    button.__tmeOnClick = onClick;
    return button;
  }

  function outputFilename(meta, kind, complete, extension) {
    const labels = {
      combined: "会议导出",
      transcript: "逐字稿",
      summary: "会议纪要",
      metadata_raw: "metadata_raw",
      transcript_raw: "minutes_raw",
      summary_raw: "summary_raw"
    };
    const base = safeFilename(meta && meta.subject ? meta.subject : "未命名会议");
    const label = labels[kind] || safeFilename(kind || "导出");
    const suffix = complete ? "" : "_incomplete";
    const ext = String(extension || "md").replace(/^\./, "");
    return `${base}_${label}${suffix}.${ext}`;
  }

  let downloadRunCounter = 0;

  function uniqueDownloadFilename(filename) {
    downloadRunCounter += 1;
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17);
    const dot = filename.lastIndexOf(".");
    if (dot < 0) return `${filename}_${stamp}_${downloadRunCounter}`;
    return `${filename.slice(0, dot)}_${stamp}_${downloadRunCounter}${filename.slice(dot)}`;
  }

  function downloadText(content, filename, mimeType) {
    if (typeof Blob !== "function" || typeof URL === "undefined" || typeof document === "undefined") {
      throw new ApiError("当前浏览器不支持本地下载");
    }
    const blob = new Blob([content], { type: mimeType || "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = uniqueDownloadFilename(filename);
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return anchor.download;
  }

  function hasUsableMinutes(result) {
    const usableRawPage = result && Array.isArray(result.rawPages) && result.rawPages.some((page) => page && page.code === 0 && page.minutes && typeof page.minutes === "object");
    return Boolean(result && ((Array.isArray(result.entries) && result.entries.length) || usableRawPage));
  }

  function hasUsableSummary(result) {
    const rawIsUsable = result && result.rawResponse && result.rawResponse.code === 0 && result.rawResponse.data && typeof result.rawResponse.data === "object";
    return Boolean(result && (result.complete || rawIsUsable || (Array.isArray(result.chapters) && result.chapters.length) || (Array.isArray(result.todos) && result.todos.length) || result.summaryHtml));
  }

  function diagnosticText(meta, minutes, summary) {
    const lines = [
      `标题：${meta ? meta.subject : "未解析"}`,
      `开始时间：${meta ? humanDate(meta.startedAtMs) : "未解析"}`,
      `duration：${meta ? formatDuration(meta.durationMs) : "未解析"}`,
      `minutes 请求页数：${minutes ? minutes.pagesRequested : 0}`,
      `paragraph 数：${minutes ? minutes.paragraphCount : 0}`,
      `sentence 数：${minutes ? minutes.sentenceCount : 0}`,
      `entry 数：${minutes ? minutes.entryCount : 0}`,
      `首条时间：${minutes ? formatOffset(minutes.firstOffsetMs) : "未提供"}`,
      `末条时间：${minutes ? formatOffset(minutes.lastOffsetMs) : "未提供"}`,
      `summary 数：${summary ? summary.chapterCount : 0}`,
      `todo 数：${summary ? summary.todoCount : 0}`,
      `逐字稿状态：${minutes && minutes.complete ? "完整" : "不完整/未取得"}`,
      `纪要状态：${summary && summary.complete ? "完整" : "不完整/未取得"}`
    ];
    if (minutes && !minutes.complete && minutes.error) lines.push(`逐字稿诊断：${minutes.error}`);
    if (summary && !summary.complete && summary.error) lines.push(`纪要诊断：${summary.error}`);
    return lines.join("\n");
  }

  function renderSummaryOnly(meta, summary) {
    const safeSummary = summary || { complete: false, chapters: [], todos: [], summaryHtml: "", error: "未取得纪要" };
    const lines = [
      `# ${meta.subject || "未命名会议"} — 会议纪要`, "",
      `- 开始时间：${humanDate(meta.startedAtMs)}`,
      `- 会议时长：${formatDuration(meta.durationMs)}`, "", "## AI 纪要", ""
    ];
    if (!safeSummary.complete) lines.push(`> ⚠️ 纪要不完整：${safeSummary.error || "接口没有确认完整结束"}`, "");
    if (safeSummary.chapters && safeSummary.chapters.length) {
      safeSummary.chapters.forEach((chapter) => lines.push(`### ${itemValue(chapter, ["title", "name", "chapter_name"], "未命名主题")}`, "", itemValue(chapter, ["summary", "content", "description", "text"], "（无内容）"), ""));
    } else lines.push("（无结构化摘要）", "");
    lines.push("### 摘要", "", plainSummaryHtml(safeSummary.summaryHtml) || "（无自由格式摘要）", "", "## 待办事项", "");
    if (safeSummary.todos && safeSummary.todos.length) safeSummary.todos.forEach((todo) => lines.push(`- [ ] ${itemValue(todo, ["todo_name", "name", "title", "content", "task"], "未命名待办")}${todoAssignees(todo)}`));
    else lines.push("（无待办）");
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }

  function renderTranscriptOnly(meta, minutes) {
    const safeMinutes = minutes || { complete: false, entries: [], error: "未取得逐字稿" };
    const entries = Array.isArray(safeMinutes.entries) ? safeMinutes.entries : [];
    const speakers = [...new Set(entries.map((entry) => entry.speaker || "未知发言人"))];
    const lines = [
      `# ${meta.subject || "未命名会议"} — 逐字稿`, "",
      `- 开始时间：${humanDate(meta.startedAtMs)}`,
      `- 会议时长：${formatDuration(meta.durationMs)}`,
      `- 发言人：${speakers.length ? speakers.join("、") : "未提供"}`, "", "## 完整逐字稿", ""
    ];
    if (!safeMinutes.complete) lines.push(`> ⚠️ 逐字稿不完整：${safeMinutes.error || "接口没有确认完整结束"}`, "");
    if (!entries.length) lines.push("（没有可用逐字稿句子）", "");
    else mergeSpeakerTurns(entries).forEach((turn) => lines.push(`### [${formatOffset(turn.startOffsetMs)}] ${turn.speaker}`, "", joinTurnTexts(turn.entries.map((entry) => entry.text || "（空句子）")), ""));
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }

  function rawModulePayload(metadata, moduleName, result) {
    const raw = buildRawPayload({ metadata, minutes: moduleName === "minutes" ? result : {}, summary: moduleName === "summary" ? result : {} });
    return { metadata: raw.metadata, [moduleName]: raw[moduleName === "minutes" ? "minutes" : "summary"] };
  }

  function saveRawArtifacts(meta, minutes, summary) {
    const saved = [];
    const metadataRaw = buildRawPayload({ metadata: meta, minutes: {}, summary: {} }).metadata;
    saved.push(downloadText(JSON.stringify({ metadata: metadataRaw }, null, 2), outputFilename(meta, "metadata_raw", true, "json"), "application/json;charset=utf-8"));
    if (hasUsableMinutes(minutes)) saved.push(downloadText(JSON.stringify(rawModulePayload(meta, "minutes", minutes), null, 2), outputFilename(meta, "transcript_raw", minutes.complete, "json"), "application/json;charset=utf-8"));
    if (hasUsableSummary(summary)) saved.push(downloadText(JSON.stringify(rawModulePayload(meta, "summary", summary), null, 2), outputFilename(meta, "summary_raw", summary.complete, "json"), "application/json;charset=utf-8"));
    return saved;
  }

  function createModal(onExport) {
    const existing = document.getElementById("tme-export-modal");
    if (existing) return existing;
    const overlay = document.createElement("div");
    overlay.id = "tme-export-modal";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:2147483001;display:flex;align-items:flex-start;justify-content:center;padding-top:90px;font-family:-apple-system,BlinkMacSystemFont,sans-serif";
    const panel = document.createElement("div");
    panel.style.cssText = "width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 120px);overflow:auto;background:#fff;border-radius:12px;padding:20px;box-shadow:0 12px 40px rgba(0,0,0,.25);color:#1f2329";
    panel.innerHTML = `<h2 style="margin:0 0 16px">${UI_TEXT.exportButton}</h2><div id="tme-options"></div><div id="tme-status" style="margin-top:16px;white-space:pre-wrap;color:#4b5563"></div><pre id="tme-diagnostics" style="display:none;white-space:pre-wrap;background:#f6f8fa;padding:12px;border-radius:8px"></pre><div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end"><button type="button" data-tme-detail>${UI_TEXT.detailButton}</button><button type="button" data-tme-close>${UI_TEXT.closeAction}</button><button type="button" data-tme-start style="background:#1677ff;color:#fff;border:0;border-radius:6px;padding:7px 14px">${UI_TEXT.exportAction}</button></div>`;
    const options = panel.querySelector("#tme-options");
    options.innerHTML = [
      ["summary", UI_TEXT.summaryOption, true],
      ["transcript", UI_TEXT.transcriptOption, true],
      ["raw", UI_TEXT.rawOption, false],
      ["separate", UI_TEXT.separateOption, false]
    ].map(([name, label, checked]) => `<label style="display:block;margin:8px 0"><input type="checkbox" data-tme-option="${name}" ${checked ? "checked" : ""}> ${label}</label>`).join("");
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    panel.querySelector("[data-tme-close]").addEventListener("click", () => overlay.remove());
    panel.querySelector("[data-tme-detail]").addEventListener("click", () => {
      const diagnostics = panel.querySelector("#tme-diagnostics");
      diagnostics.style.display = diagnostics.style.display === "none" ? "block" : "none";
    });
    panel.querySelector("[data-tme-start]").addEventListener("click", () => {
      const selected = {};
      panel.querySelectorAll("[data-tme-option]").forEach((input) => { selected[input.dataset.tmeOption] = input.checked; });
      onExport({ panel, overlay, options: selected });
    });
    return overlay;
  }

  async function loadPageMetadata() {
    const timeoutAt = Date.now() + 15000;
    let lastError = null;
    while (Date.now() < timeoutAt) {
      try {
        return parseSharePage(document.documentElement.outerHTML, location.href);
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new ApiError(`分享页数据尚未就绪: ${errorMessage(lastError)}`);
  }

  async function runExport(meta, selected, panel) {
    const status = panel.querySelector("#tme-status");
    const diagnostics = panel.querySelector("#tme-diagnostics");
    const startButton = panel.querySelector("[data-tme-start]");
    startButton.disabled = true;
    status.textContent = UI_TEXT.loading;
    const minutesPromise = selected.transcript
      ? fetchMinutes(meta, requestJson)
      : Promise.resolve({ complete: false, pagesRequested: 0, paragraphCount: 0, sentenceCount: 0, entryCount: 0, entries: [], rawPages: [], error: "未选择逐字稿" });
    const summaryPromise = selected.summary
      ? fetchSummary(meta, requestJson)
      : Promise.resolve({ complete: false, chapterCount: 0, todoCount: 0, chapters: [], todos: [], summaryHtml: "", rawResponse: null, error: "未选择纪要" });
    const [minutes, summary] = await Promise.all([minutesPromise, summaryPromise]);
    diagnostics.textContent = diagnosticText(meta, minutes, summary);
    const usableMinutes = hasUsableMinutes(minutes);
    const usableSummary = hasUsableSummary(summary);
    const files = [];
    if (usableMinutes || usableSummary) {
      if (selected.separate) {
        if (usableSummary) files.push(downloadText(renderSummaryOnly(meta, summary), outputFilename(meta, "summary", summary.complete, "md"), "text/markdown;charset=utf-8"));
        if (usableMinutes) files.push(downloadText(renderTranscriptOnly(meta, minutes), outputFilename(meta, "transcript", minutes.complete, "md"), "text/markdown;charset=utf-8"));
      } else {
        const markdown = renderMarkdown(meta, minutes, summary);
        files.push(downloadText(markdown, outputFilename(meta, "combined", minutes.complete && summary.complete, "md"), "text/markdown;charset=utf-8"));
      }
    }
    if (selected.raw) files.push(...saveRawArtifacts(meta, minutes, summary));
    const partial = !minutes.complete || !summary.complete;
    status.textContent = files.length
      ? `${partial ? "部分成功" : "导出完成"}：已生成 ${files.length} 个文件。再次执行会使用新的唯一文件名。`
      : "导出失败：两个模块都没有取得可用响应。";
    startButton.disabled = false;
    return { meta, minutes, summary, files, partial };
  }

  function bootPageUI() {
    if (typeof document === "undefined" || !document.body || globalObject.__TME_EXPORT_TEST__ === true) return;
    if (globalObject.__TME_EXPORT_UI_BOOTED__) return;
    globalObject.__TME_EXPORT_UI_BOOTED__ = true;
    const install = () => {
      if (!document.body) return;
      ensureExportButton(document.body, () => {
        createModal(async ({ panel, options }) => {
          try {
            const meta = await loadPageMetadata();
            await runExport(meta, options, panel);
          } catch (error) {
            const status = panel.querySelector("#tme-status");
            status.textContent = `导出失败：${errorMessage(error)}`;
            const startButton = panel.querySelector("[data-tme-start]");
            startButton.disabled = false;
          }
        });
      });
    };
    install();
    const observer = typeof MutationObserver === "function" ? new MutationObserver(install) : null;
    if (observer) observer.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(install, 1500);
  }

  const CORE = {
    ApiError,
    MINUTES_DETAIL_PATH,
    SUMMARY_PATH,
    MINUTES_PAGE_LIMIT,
    parseSharePage,
    parseMinutesPage,
    sentenceText,
    flattenParagraphs,
    fetchMinutes,
    fetchSummary,
    DEFAULT_TURN_MERGE_GAP_MS,
    formatOffset,
    formatDuration,
    safeFilename,
    mergeSpeakerTurns,
    joinTurnTexts,
    renderMarkdown,
    buildRawPayload,
    USERSCRIPT_METADATA,
    UI_TEXT,
    buildFetchOptions,
    requestJson,
    ensureExportButton,
    outputFilename,
    downloadText,
    hasUsableMinutes,
    hasUsableSummary,
    loadPageMetadata,
    runExport
  };

  const globalObject = typeof globalThis !== "undefined" ? globalThis : window;
  if (globalObject.__TME_EXPORT_TEST__ === true) {
    globalObject.TencentMeetingExportCore = CORE;
  }

  // The browser UI is added in later execution-plan tasks. Keeping the pure
  // core available without bootstrapping on local test files makes the Edge
  // harness deterministic and avoids touching unrelated pages.
  if (typeof document === "undefined" || typeof location === "undefined") return;
  if (location.hostname !== "meeting.tencent.com" || !location.pathname.startsWith("/cw/")) return;
  bootPageUI();
})();

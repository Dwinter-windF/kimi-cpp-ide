/**
 * AI 流式请求层（OpenAI 兼容 /chat/completions，stream: true）—— 全应用唯一一份实现。
 *
 * 与 src/lib/ai.ts 的关系：
 *  · 鉴权头 / 接口地址归一化 / 请求体组装 全部复用 ai.ts 的
 *    isAiConfigured、resolveAiEndpoint、buildChatBody（不复制粘贴）；
 *  · 本模块只补上「SSE 逐块读取 + 逐条 data: 解析 + 中止/超时」这件事。
 *
 * 使用方：src/lib/aiGhost.ts（编辑器内联流式补全）。
 *
 * 错误处理约定（与 requestChat 一致）：**不抛异常**，一律返回中文 error。
 * 且不是硬错误（解析不出内容等）也绝不抛出——调用方按「静默丢弃」处理，
 * 不会打断用户打字。
 */
import { buildChatBody, resolveAiEndpoint, type ChatMessage } from "@/lib/ai";
import type { Settings } from "@/types";

/**
 * 组装一条 SSE `data:` 负载中的增量文本。
 * 返回 "" 表示这一条没有可显示内容：心跳、空 choices、[DONE]、或负载不是合法 JSON
 * （解析失败一律当空增量吞掉，绝不让流式解析把编辑器搞崩）。
 */
export function parseStreamDelta(json: string): string {
  const s = json.trim();
  if (!s || s === "[DONE]") return "";
  try {
    const obj = JSON.parse(s) as {
      choices?: { delta?: { content?: unknown }; message?: { content?: unknown } }[];
    };
    const choice = obj.choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === "string") return delta;
    // 少数接口在流式最后一帧把整段文本放在 message.content 里：一并兼容
    const whole = choice?.message?.content;
    return typeof whole === "string" ? whole : "";
  } catch {
    return "";
  }
}

/**
 * 把「一帧里可能含多条 data: 的数据块」拆成多条负载。
 *
 * SSE 规范里事件以空行结束，但真实接口经常把多条 `data:` 连排在一帧里，
 * 所以这里按行扫描：`data:` 前缀（允许 `data:` 后有空格）之后的整行就是负载；
 * 其它字段（event: / id: / retry: / `:` 开头的心跳注释）直接忽略。
 */
export function splitSseData(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    out.push(t.slice(5).trim());
  }
  return out;
}

/**
 * 把一个 signal（调用方的）与一个 controller（内部超时用的）合成一个：
 * 任一触发则合成信号为 aborted。避免依赖较新的 AbortSignal.any，兼容性更稳。
 */
function compositeSignal(controller: AbortController, external?: AbortSignal): AbortSignal {
  if (!external) return controller.signal;
  if (external.aborted) {
    controller.abort();
    return controller.signal;
  }
  const forward = () => controller.abort();
  external.addEventListener("abort", forward, { once: true });
  return controller.signal;
}

export interface AiStreamOptions {
  settings: Settings;
  messages: ChatMessage[];
  /** 温度：内联补全用 0.2（见 src/lib/aiGhost.ts），要稳定复现 */
  temperature: number;
  /**
   * 单次请求的整体超时（ms）。超时同样走 abortSignal，因此调用方无需区分
   * 「自己中止」与「超时」——两种情况的产物都直接丢弃。
   */
  timeoutMs: number;
  /** 调用方的中止开关：用户继续输入 / 移动光标 / 切文件时立刻 abort */
  signal?: AbortSignal;
  /** 每收到一段增量调用一次；抛出的异常会被吞掉，不影响流的继续读取 */
  onDelta?: (text: string) => void;
}

/**
 * 发一次流式 /chat/completions，逐段把增量喂给 onDelta，结束时返回拼接好的全文。
 *
 * 中止语义：opts.signal 触发或超过 timeoutMs 时，fetch / reader 立即 abort，
 * 本函数返回 { text: 已收到的部分 } 且 **error 为空**——这是「用户自己不想看了」，
 * 不是失败，调用方直接丢弃即可（静默，不弹任何提示）。
 */
export async function streamChat(
  opts: AiStreamOptions
): Promise<{ text: string; error?: string }> {
  const { settings, messages, temperature, timeoutMs, signal, onDelta } = opts;
  const endpoint = resolveAiEndpoint(settings);
  if (!endpoint) return { text: "", error: "未配置 AI 接口" };

  const ctrl = new AbortController();
  const composite = compositeSignal(ctrl, signal);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);

  let text = "";
  try {
    let resp: Response;
    try {
      resp = await fetch(endpoint + "/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.aiKey || ""}`,
        },
        signal: composite,
        // DeepSeek 的推理型模型（deepseek-flash 等）默认先输出数千 token 的推理过程，
        // 首个内容 token 要等十几秒——内联补全对延迟极敏感，用户早已按 Tab 缩进了。
        // 对该端点关闭推理（实测 17.7s → 0.8s）；其它厂商端点不加此私有参数，避免 400。
        body: JSON.stringify(
          buildChatBody(settings, messages, temperature, true, /deepseek/i.test(endpoint)
            ? { thinking: { type: "disabled" } }
            : undefined)
        ),
      });
    } catch (e) {
      if (signal?.aborted || timedOut) return { text }; // 主动中止 / 超时：不算错误
      return { text, error: `AI 请求失败：${e instanceof Error ? e.message : String(e)}` };
    }
    if (!resp.ok) {
      // 响应体只取一小段做诊断信息，且只有调用方想看的时候才用得上
      const raw = await resp.text().catch(() => "");
      return { text, error: `AI 接口返回 ${resp.status}：${raw.slice(0, 200)}` };
    }
    if (!resp.body) {
      // 极少数环境拿不到可读流：退化成一次性读取，仍有结果可用
      const raw = await resp.text().catch(() => "");
      for (const data of splitSseData(raw)) {
        const d = parseStreamDelta(data);
        if (d) {
          text += d;
          onDelta?.(d);
        }
      }
      return { text };
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // 末尾可能只有半条 `data:`：留在 buf 里等下一块，绝不解析半条 JSON
        const cut = buf.lastIndexOf("\n");
        if (cut < 0) continue;
        const frame = buf.slice(0, cut);
        buf = buf.slice(cut + 1);
        for (const data of splitSseData(frame)) {
          if (data === "[DONE]") return { text };
          const delta = parseStreamDelta(data);
          if (!delta) continue;
          text += delta;
          try {
            onDelta?.(delta);
          } catch {
            /* 渲染增量时的异常不影响后续增量（健壮性：解析/渲染失败都不崩） */
          }
        }
      }
      // 流结束时 buf 里可能还剩最后一条没有换行结尾的 data:
      for (const data of splitSseData(buf)) {
        if (data === "[DONE]") break;
        const delta = parseStreamDelta(data);
        if (!delta) continue;
        text += delta;
        try {
          onDelta?.(delta);
        } catch {
          /* 同上 */
        }
      }
    } catch (e) {
      if (signal?.aborted || timedOut) return { text };
      return { text, error: `AI 流式读取中断：${e instanceof Error ? e.message : String(e)}` };
    } finally {
      void reader.cancel().catch(() => undefined); // 提前 return（[DONE]）时释放底层连接
    }
    return { text };
  } finally {
    clearTimeout(timer);
  }
}

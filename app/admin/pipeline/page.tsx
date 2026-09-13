"use client";

import { useEffect, useMemo, useState } from "react";

const ADMIN_KEY_STORAGE = "kpoparkive:namu-admin-key";

type RootRow = {
  rootTitle: string;
  updatedAt?: string | null;
};

type CollectionCheck = {
  rootTitle: string;
  clusterDocuments: number;
  coreCount: number;
  templateDependencyCount: number;
  reusableFallbackCount?: number;
  needsRawCount: number;
  missingRaw?: Array<{
    title: string;
    priority: number;
    reasons?: string[];
  }>;
};

type RunStatus = {
  id: string;
  root_title: string;
  status: string;
  scope_count: number;
  completed_count: number;
  config?: {
    dependencyCount?: number;
  } | null;
  failed_count: number;
  review_count: number;
  runner_id?: string | null;
  heartbeat_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
};

type BatchStatus = {
  control?: {
    roots?: string[];
    pid?: number;
    startedAt?: string;
  } | null;
  state?: {
    updatedAt?: string;
    teams?: Record<
      string,
      {
        status?: string;
        attempts?: number;
        startedAt?: string;
        completedAt?: string;
        lastExitCode?: number;
      }
    >;
  } | null;
  logTail?: string;
  batch?: BatchStatus | null;
};

type StatusResponse = {
  run?: RunStatus | null;
  capture?: {
    available?: boolean;
    job?: {
      running?: boolean;
      done?: boolean;
      rootTitle?: string;
      processed?: number;
      captured?: number;
      failed?: number;
      queued?: number;
      current?: string[];
    } | null;
    error?: string;
  };
  jobsSummary?: {
    byStage?: Record<string, Record<string, number>>;
    coreByStage?: Record<string, Record<string, number>>;
    dependencyByStage?: Record<string, Record<string, number>>;
    dependencyProgress?: {
      total: number;
      ready: number;
      waiting: number;
    };
    review?: Array<{
      id: string;
      source_title: string;
      stage: string;
      status: string;
      attempt: number;
      max_attempts: number;
      chunk_current: number;
      chunk_total: number;
      last_error?: string | null;
      dependency?: boolean;
    }>;
  };
  logTail?: string;
};

const stageOrder = [
  "source_render",
  "translation",
  "en_render",
  "publish",
  "integration_qa",
];

const stageLabel: Record<string, string> = {
  source_render: "원문 렌더",
  translation: "영문 번역",
  en_render: "영문 렌더",
  publish: "게시",
  integration_qa: "최종 QA",
};

function countStage(values?: Record<string, number>) {
  if (!values) return 0;
  return Object.values(values).reduce((sum, value) => sum + Number(value || 0), 0);
}

export default function PipelineAdminPage() {
  const [adminKey, setAdminKey] = useState("");
  const [rootTitle, setRootTitle] = useState("");
  const [roots, setRoots] = useState<RootRow[]>([]);
  const [collection, setCollection] = useState<CollectionCheck | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [batch, setBatch] = useState<BatchStatus | null>(null);
  const [batchText, setBatchText] = useState("");
  const [message, setMessage] = useState("확장프로그램 수집 완료 후 팀을 선택하세요.");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(ADMIN_KEY_STORAGE);
      if (saved) setAdminKey(saved);
    } catch {}
  }, []);

  useEffect(() => {
    if (!adminKey) return;
    try {
      window.localStorage.setItem(ADMIN_KEY_STORAGE, adminKey);
    } catch {}
  }, [adminKey]);

  const headers = useMemo(
    () => ({
      "Content-Type": "application/json",
      "x-admin-key": adminKey,
    }),
    [adminKey],
  );

  async function api(path: string, init: RequestInit = {}) {
    const response = await fetch(path, {
      ...init,
      headers: {
        ...headers,
        ...(init.headers || {}),
      },
      cache: "no-store",
    });

    const result = await response.json();

    if (!response.ok) {
      const error = new Error(result.error || "Request failed") as Error & {
        payload?: any;
        status?: number;
      };
      error.payload = result;
      error.status = response.status;
      throw error;
    }

    return result;
  }

  async function loadRoots() {
    if (!adminKey) return;

    try {
      const result = await api("/api/admin/pipeline-control");
      setRoots(Array.isArray(result.roots) ? result.roots : []);
      setBatch(result.batch || null);

      if (!rootTitle && result.roots?.[0]?.rootTitle) {
        setRootTitle(result.roots[0].rootTitle);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "팀 목록 조회 실패");
    }
  }

  async function refreshStatus() {
    if (!adminKey || !rootTitle) return;

    try {
      const result = await api(
        "/api/admin/pipeline-control?root=" + encodeURIComponent(rootTitle),
      );
      setStatus(result);
      setBatch(result.batch || null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "상태 조회 실패");
    }
  }

  useEffect(() => {
    void loadRoots();
  }, [adminKey]);

  useEffect(() => {
    setCollection(null);
    setStatus(null);
    if (!adminKey || !rootTitle) return;

    void refreshStatus();

    const timer = window.setInterval(() => {
      void refreshStatus();
    }, 3000);

    return () => window.clearInterval(timer);
  }, [adminKey, rootTitle]);

  async function runAction(action: "check" | "start" | "retry" | "stop") {
    if (!rootTitle || !adminKey) return;

    setBusy(true);

    try {
      if (action === "check") {
        setMessage("수집된 DOM/RAW 상태를 검사하는 중...");
      } else if (action === "start") {
        setMessage("후처리 자동화를 시작하는 중...");
      } else if (action === "retry") {
        setMessage("REVIEW 문서를 다시 큐에 넣는 중...");
      } else {
        setMessage("로컬 pipeline을 중지하는 중...");
      }

      const result = await api("/api/admin/pipeline-control", {
        method: "POST",
        body: JSON.stringify({ action, rootTitle }),
      });

      if (result.collection) setCollection(result.collection);

      if (action === "check") {
        setMessage(
          result.ready
            ? "수집 완료. 자동 처리를 시작할 수 있습니다."
            : "수집이 덜 끝났습니다. 누락 RAW를 확장프로그램에서 먼저 수집하세요.",
        );
      } else if (action === "start") {
        setMessage(
          result.alreadyRunning
            ? "이미 실행 중입니다."
            : "자동 처리를 시작했습니다. 이제 번역 → 렌더 → 게시 → QA가 자동 진행됩니다.",
        );
      } else if (action === "retry") {
        setMessage("REVIEW 문서를 재시도하도록 시작했습니다.");
      } else {
        setMessage("pipeline을 일시 중지했습니다.");
      }

      await refreshStatus();
    } catch (error: any) {
      if (error?.payload?.collection) {
        setCollection(error.payload.collection);
      }

      if (error?.payload?.code === "COLLECTION_RUNNING") {
        setMessage(
          "이 팀은 확장프로그램에서 아직 수집 중입니다. 수집 완료 후 자동 처리를 시작하세요.",
        );
      } else if (error?.payload?.code === "COLLECTION_REQUIRED") {
        setMessage(
          "수집 불완전: 아래 누락 RAW를 확장프로그램에서 수집한 뒤 다시 확인하세요.",
        );
      } else {
        setMessage(error instanceof Error ? error.message : "작업 실패");
      }
    } finally {
      setBusy(false);
    }
  }

  function parsedBatchRoots() {
    return [
      ...new Set(
        batchText
          .split(/[\n,]+/)
          .map((value) => value.normalize("NFKC").trim())
          .filter(Boolean),
      ),
    ];
  }

  async function runBatchAction(action: "batch_start" | "batch_stop") {
    if (!adminKey) return;

    const batchRoots = parsedBatchRoots();

    if (action === "batch_start" && batchRoots.length === 0) {
      setMessage("일괄 처리할 팀 이름을 한 줄에 하나씩 입력하세요.");
      return;
    }

    setBusy(true);

    try {
      setMessage(
        action === "batch_start"
          ? "일괄 자동 처리를 시작하는 중..."
          : "일괄 처리를 중지하는 중...",
      );

      const result = await api("/api/admin/pipeline-control", {
        method: "POST",
        body: JSON.stringify({
          action,
          roots: batchRoots,
        }),
      });

      setBatch(result.batch || null);

      if (action === "batch_start") {
        const deferred = Array.isArray(result.deferredRoots)
          ? result.deferredRoots
          : [];

        setMessage(
          "일괄 자동 처리를 시작했습니다. 수집 불완전 팀은 자동으로 건너뜁니다." +
            (deferred.length
              ? " 현재 수집 중이라 제외: " + deferred.join(", ")
              : ""),
        );
      } else {
        setMessage("일괄 처리를 중지했습니다.");
      }

      await loadRoots();
      await refreshStatus();
    } catch (error: any) {
      if (error?.payload?.batch) {
        setBatch(error.payload.batch);
      }

      if (error?.payload?.code === "BATCH_RUNNING") {
        setMessage("이미 일괄 처리가 실행 중입니다.");
      } else if (error?.payload?.code === "COLLECTION_RUNNING") {
        setMessage(
          "선택한 팀이 아직 확장프로그램에서 수집 중입니다.",
        );
      } else {
        setMessage(
          error instanceof Error ? error.message : "일괄 처리 실패",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  const run = status?.run || null;
  const capture = status?.capture || null;
  const captureJob = capture?.job || null;
  const sameTeamCollecting =
    capture?.available === true &&
    captureJob?.running === true &&
    String(captureJob?.rootTitle || "").normalize("NFKC").trim() ===
      rootTitle.normalize("NFKC").trim();

  const byStage = status?.jobsSummary?.coreByStage || {};
  const dependencyByStage =
    status?.jobsSummary?.dependencyByStage || {};
  const dependencyProgress =
    status?.jobsSummary?.dependencyProgress || {
      total: Number(
        run?.config?.dependencyCount ||
          collection?.templateDependencyCount ||
          0,
      ),
      ready: 0,
      waiting: Number(
        run?.config?.dependencyCount ||
          collection?.templateDependencyCount ||
          0,
      ),
    };
  const review = status?.jobsSummary?.review || [];

  const collectionReady =
    collection != null && Number(collection.needsRawCount || 0) === 0;

  const progress =
    run && Number(run.scope_count || 0) > 0
      ? Math.round(
          (Number(run.completed_count || 0) / Number(run.scope_count || 1)) *
            100,
        )
      : 0;

  const batchTeams = batch?.state?.teams || {};
  const batchEntries = Object.entries(batchTeams);
  const batchCounts = batchEntries.reduce<Record<string, number>>(
    (acc, [, item]) => {
      const key = String(item?.status || "unknown");
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    },
    {},
  );
  const batchActive = batchEntries.some(([, item]) =>
    ["pending", "running", "retry"].includes(
      String(item?.status || ""),
    ),
  );

  function forgetAdminKey() {
    try {
      window.localStorage.removeItem(ADMIN_KEY_STORAGE);
    } catch {}
    setAdminKey("");
    setRoots([]);
    setCollection(null);
    setStatus(null);
    setMessage("저장된 Admin key를 지웠습니다.");
  }

  return (
    <main className="adminShell">
      <section className="adminPanel">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start" }}>
          <div>
            <h1>Kpoparkive 자동 처리</h1>
            <p className="adminIntro">
              NamuWiki 수집은 기존 Chrome 확장프로그램에서 직접 시작합니다.
              이 화면은 수집 완료 후 번역·QA·렌더·게시만 자동 처리합니다.
            </p>
          </div>
          <a href="/admin/namu-import">Importer</a>
        </div>

        <div
          style={{
            padding: 14,
            border: "1px solid rgba(127,127,127,.3)",
            borderRadius: 10,
            marginBottom: 18,
          }}
        >
          <strong>운영 순서</strong>
          <div style={{ marginTop: 8, lineHeight: 1.7 }}>
            ① 확장프로그램으로 DOM/RAW 수집 → ② 여기서 수집 상태 확인 →
            ③ 자동 처리 시작 → ④ REVIEW가 생긴 문서만 확인
          </div>
        </div>

        <div className="adminForm">
          <label>
            Admin key
            <input
              type="password"
              value={adminKey}
              onChange={(event) => setAdminKey(event.target.value)}
              autoComplete="current-password"
            />
          </label>

          <button type="button" disabled={!adminKey} onClick={forgetAdminKey}>
            저장된 key 지우기
          </button>

          <label>
            수집 완료된 팀
            <input
              list="pipeline-roots"
              value={rootTitle}
              onChange={(event) => setRootTitle(event.target.value)}
              placeholder="예: BLACKPINK"
            />
            <datalist id="pipeline-roots">
              {roots.map((item) => (
                <option key={item.rootTitle} value={item.rootTitle} />
              ))}
            </datalist>
          </label>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={busy || !adminKey || !rootTitle}
              onClick={() => void runAction("check")}
            >
              수집 상태 확인
            </button>

            <button
              type="button"
              disabled={
                busy ||
                !adminKey ||
                !rootTitle ||
                sameTeamCollecting ||
                run?.status === "running"
              }
              onClick={() => void runAction("start")}
            >
              수집 후 자동 처리 시작
            </button>

            <button
              type="button"
              disabled={
                busy ||
                !adminKey ||
                !rootTitle ||
                !["paused", "failed"].includes(String(run?.status || ""))
              }
              onClick={() => void runAction("retry")}
            >
              REVIEW 재시도
            </button>

            <button
              type="button"
              disabled={
                busy ||
                !adminKey ||
                !rootTitle ||
                run?.status !== "running"
              }
              onClick={() => void runAction("stop")}
            >
              일시 중지
            </button>
          </div>
        </div>

        <pre className="adminStatus" style={{ whiteSpace: "pre-wrap" }}>
          {message}
        </pre>

        <section style={{ marginTop: 18 }}>
          <h2>확장프로그램 수집</h2>
          <div
            style={{
              border: "1px solid rgba(127,127,127,.3)",
              borderRadius: 10,
              padding: 14,
            }}
          >
            {!capture?.available ? (
              <div>
                Capture helper 연결 안 됨
                {capture?.error ? " · " + capture.error : ""}
              </div>
            ) : !captureJob?.rootTitle ? (
              <div>현재 수집 작업 없음</div>
            ) : (
              <>
                <div style={{ fontWeight: 700 }}>
                  {captureJob.rootTitle} ·{" "}
                  {captureJob.running
                    ? "수집 중"
                    : captureJob.done
                      ? "수집 완료"
                      : "대기"}
                </div>
                <div style={{ marginTop: 6, opacity: 0.8 }}>
                  처리 {captureJob.processed ?? 0} · 캡처{" "}
                  {captureJob.captured ?? 0} · 대기{" "}
                  {captureJob.queued ?? 0} · 실패{" "}
                  {captureJob.failed ?? 0}
                </div>
                {sameTeamCollecting && (
                  <div style={{ marginTop: 8, fontWeight: 700 }}>
                    현재 선택한 팀을 수집 중입니다. 자동 처리는 수집 완료 후
                    시작됩니다.
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        <section style={{ marginTop: 24 }}>
          <h2>일괄 자동 처리</h2>
          <p style={{ opacity: 0.8, lineHeight: 1.65 }}>
            확장프로그램으로 수집을 끝낸 팀 이름을 한 줄에 하나씩 입력하세요.
            기본 2팀을 병렬 처리합니다. 수집이 덜 된 팀은 건너뛰고 다음 팀을
            계속 처리합니다.
          </p>

          <textarea
            value={batchText}
            onChange={(event) => setBatchText(event.target.value)}
            placeholder={"BLACKPINK\naespa\nIVE"}
            rows={6}
            style={{
              width: "100%",
              boxSizing: "border-box",
              marginBottom: 10,
              padding: 10,
              font: "inherit",
            }}
          />

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={busy || !adminKey || parsedBatchRoots().length === 0 || batchActive}
              onClick={() => void runBatchAction("batch_start")}
            >
              일괄 자동 처리 시작
            </button>

            <button
              type="button"
              disabled={busy || !adminKey || !batchActive}
              onClick={() => void runBatchAction("batch_stop")}
            >
              일괄 처리 중지
            </button>

            <button
              type="button"
              disabled={!rootTitle}
              onClick={() => {
                if (!rootTitle) return;
                const current = parsedBatchRoots();
                if (!current.includes(rootTitle)) {
                  setBatchText([...current, rootTitle].join("\n"));
                }
              }}
            >
              현재 팀 목록에 추가
            </button>
          </div>

          {batchEntries.length > 0 && (
            <div
              style={{
                marginTop: 14,
                border: "1px solid rgba(127,127,127,.3)",
                borderRadius: 10,
                padding: 14,
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 8 }}>
                Batch 상태 ·{" "}
                {Object.entries(batchCounts)
                  .sort()
                  .map(([key, value]) => key + " " + value)
                  .join(" · ")}
              </div>

              <div style={{ maxHeight: 280, overflow: "auto" }}>
                {batchEntries.map(([team, item]) => (
                  <div
                    key={team}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 12,
                      padding: "6px 0",
                      borderTop: "1px solid rgba(127,127,127,.15)",
                    }}
                  >
                    <span>{team}</span>
                    <strong>{item?.status || "unknown"}</strong>
                  </div>
                ))}
              </div>

              {batch?.logTail && (
                <details style={{ marginTop: 12 }}>
                  <summary style={{ cursor: "pointer" }}>
                    Batch 로그
                  </summary>
                  <pre
                    className="adminStatus"
                    style={{
                      maxHeight: 300,
                      overflow: "auto",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {batch.logTail}
                  </pre>
                </details>
              )}
            </div>
          )}
        </section>

        {collection && (
          <section style={{ marginTop: 22 }}>
            <h2>수집 상태</h2>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                gap: 10,
              }}
            >
              {[
                ["수집 문서", collection.clusterDocuments],
                ["Core 문서", collection.coreCount],
                ["Template 의존성", collection.templateDependencyCount],
                ["DOM fallback 재사용", collection.reusableFallbackCount ?? 0],
                ["누락 RAW", collection.needsRawCount],
              ].map(([label, value]) => (
                <div
                  key={String(label)}
                  style={{
                    border: "1px solid rgba(127,127,127,.3)",
                    borderRadius: 10,
                    padding: 14,
                  }}
                >
                  <div style={{ opacity: 0.7, fontSize: 13 }}>{label}</div>
                  <div style={{ fontSize: 26, fontWeight: 800 }}>{value}</div>
                </div>
              ))}
            </div>

            {Number(collection.needsRawCount || 0) > 0 && (
              <details open style={{ marginTop: 14 }}>
                <summary style={{ cursor: "pointer", fontWeight: 700 }}>
                  확장프로그램에서 추가 수집해야 할 RAW
                </summary>
                <ul>
                  {(collection.missingRaw || []).slice(0, 60).map((item) => (
                    <li key={item.title}>
                      {item.title}
                      {item.reasons?.length
                        ? " · " + item.reasons.join(", ")
                        : ""}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        )}

        <section style={{ marginTop: 26 }}>
          <h2>자동 처리 진행률</h2>

          {!run ? (
            <p>아직 pipeline run이 없습니다.</p>
          ) : (
            <>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  flexWrap: "wrap",
                  marginBottom: 8,
                }}
              >
                <strong>
                  {run.status.toUpperCase()} · {run.completed_count}/
                  {run.scope_count}
                </strong>
                <span>
                  REVIEW {run.review_count} · FAILED {run.failed_count}
                </span>
              </div>

              <div
                style={{
                  height: 10,
                  borderRadius: 999,
                  overflow: "hidden",
                  background: "rgba(127,127,127,.2)",
                  marginBottom: 16,
                }}
              >
                <div
                  style={{
                    width: progress + "%",
                    minWidth: progress > 0 ? 4 : 0,
                    height: "100%",
                    background: "currentColor",
                    transition: "width .2s ease",
                  }}
                />
              </div>

              <h3 style={{ marginTop: 20, marginBottom: 10 }}>
                Core 공개 문서
              </h3>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                  gap: 10,
                }}
              >
                {stageOrder.map((stage) => {
                  const values = byStage[stage] || {};
                  const total = countStage(values);
                  const pass = Number(values.pass || 0);
                  const active =
                    Number(values.running || 0) +
                    Number(values.queued || 0) +
                    Number(values.retry || 0);

                  return (
                    <div
                      key={stage}
                      style={{
                        border: "1px solid rgba(127,127,127,.3)",
                        borderRadius: 10,
                        padding: 14,
                      }}
                    >
                      <div style={{ fontWeight: 700 }}>
                        {stageLabel[stage] || stage}
                      </div>
                      <div style={{ marginTop: 7 }}>
                        {pass}/{total || 0} PASS
                      </div>
                      <small style={{ opacity: 0.7 }}>
                        진행/대기 {active}
                      </small>
                    </div>
                  );
                })}
              </div>

              {dependencyProgress.total > 0 && (
                <>
                  <h3 style={{ marginTop: 24, marginBottom: 10 }}>
                    Template dependency · {dependencyProgress.ready}/
                    {dependencyProgress.total} 준비
                  </h3>

                  <div
                    style={{
                      height: 8,
                      borderRadius: 999,
                      overflow: "hidden",
                      background: "rgba(127,127,127,.2)",
                      marginBottom: 12,
                    }}
                  >
                    <div
                      style={{
                        width:
                          Math.round(
                            (dependencyProgress.ready /
                              Math.max(1, dependencyProgress.total)) *
                              100,
                          ) + "%",
                        height: "100%",
                        background: "currentColor",
                        opacity: 0.6,
                        transition: "width .2s ease",
                      }}
                    />
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(150px, 1fr))",
                      gap: 10,
                    }}
                  >
                    {["source_render", "translation", "en_render"].map(
                      (stage) => {
                        const values =
                          dependencyByStage[stage] || {};
                        const total = countStage(values);
                        const pass = Number(values.pass || 0);
                        const active =
                          Number(values.running || 0) +
                          Number(values.queued || 0) +
                          Number(values.retry || 0);

                        return (
                          <div
                            key={"dependency-" + stage}
                            style={{
                              border:
                                "1px solid rgba(127,127,127,.3)",
                              borderRadius: 10,
                              padding: 14,
                            }}
                          >
                            <div style={{ fontWeight: 700 }}>
                              {stageLabel[stage] || stage}
                            </div>
                            <div style={{ marginTop: 7 }}>
                              {pass}/{total || 0} PASS
                            </div>
                            <small style={{ opacity: 0.7 }}>
                              진행/대기 {active}
                            </small>
                          </div>
                        );
                      },
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </section>

        {review.length > 0 && (
          <section style={{ marginTop: 26 }}>
            <h2>사람 확인 필요</h2>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th align="left">문서</th>
                    <th align="left">단계</th>
                    <th align="left">상태</th>
                    <th align="left">오류</th>
                  </tr>
                </thead>
                <tbody>
                  {review.map((job) => (
                    <tr key={job.id}>
                      <td style={{ padding: "8px 6px" }}>
                        {job.source_title}
                        {job.dependency ? " · Template" : ""}
                      </td>
                      <td style={{ padding: "8px 6px" }}>
                        {stageLabel[job.stage] || job.stage}
                      </td>
                      <td style={{ padding: "8px 6px" }}>{job.status}</td>
                      <td style={{ padding: "8px 6px" }}>
                        {job.last_error || "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <details style={{ marginTop: 26 }}>
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>
            로컬 worker 로그
          </summary>
          <pre
            className="adminStatus"
            style={{
              marginTop: 10,
              maxHeight: 420,
              overflow: "auto",
              whiteSpace: "pre-wrap",
            }}
          >
            {status?.logTail || "로그 없음"}
          </pre>
        </details>
      </section>
    </main>
  );
}

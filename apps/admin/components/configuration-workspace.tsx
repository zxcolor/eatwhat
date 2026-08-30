"use client";

import {
	type FormEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import {
	AdminClientError,
	loadAdminConfiguration,
	loadAdminConfigurationHistory,
	rollbackAdminConfiguration,
	updateAdminConfiguration,
} from "../lib/admin-client";
import type {
	AdminConfigKey,
	AdminConfigRecord,
	AdminConfigUpdateReason,
	AdminConfigValueMap,
	AiAssistanceConfigValue,
	CoverageDefaultConfigValue,
	MinimumClientVersionConfigValue,
	RecommendationPromptConfigValue,
	RecommendationRulesConfigValue,
} from "../lib/admin-contract";
import {
	ADMIN_CONFIG_DEFINITIONS,
	ADMIN_REGISTERED_MODEL_VERSIONS,
	ADMIN_REGISTERED_PROMPT_VERSIONS,
} from "../lib/admin-contract";
import {
	replaceReloadedConfigurationRecord,
	updateDirtyConfigKeys,
} from "../lib/configuration-state";
import { useAdminSession } from "./admin-shell";

type RecordFor<K extends AdminConfigKey> = Extract<
	AdminConfigRecord,
	{ configKey: K }
>;
type Notice = { tone: "success" | "error" | "info"; text: string };

const CONFIG_GROUPS = [
	{ key: "features.ai-assistance", short: "AI", label: "AI 辅助" },
	{ key: "recommendations.rules", short: "规", label: "推荐规则" },
	{ key: "recommendations.prompt", short: "词", label: "提示词与模型" },
	{ key: "coverage.default", short: "域", label: "默认覆盖" },
	{ key: "clients.minimum-version", short: "版", label: "最低客户端版本" },
] as const;

const REASON_OPTIONS: Array<{
	value: AdminConfigUpdateReason;
	label: string;
	help: string;
}> = [
	{
		value: "ROUTINE_TUNING",
		label: "日常调优",
		help: "常规参数维护与效果调整",
	},
	{
		value: "INCIDENT_RESPONSE",
		label: "故障响应",
		help: "为控制线上故障影响进行的变更",
	},
	{
		value: "RELEASE_COMPATIBILITY",
		label: "版本兼容",
		help: "配合客户端或服务端发布的兼容调整",
	},
];

const DEFAULT_AI: AiAssistanceConfigValue = { enabled: false };
const DEFAULT_RULES: RecommendationRulesConfigValue = {
	qualityWeight: 25,
	timeWeight: 25,
	budgetWeight: 20,
	intentWeight: 15,
	diversityWeight: 10,
	operationsAdjustmentMaximum: 5,
};
const DEFAULT_PROMPT: RecommendationPromptConfigValue = {
	enabled: false,
	promptVersion: "intent-prompt-v1",
	modelVersion: "qwen3.7-flash-2026-07-15",
	timeoutMs: 1_800,
};
const DEFAULT_COVERAGE: CoverageDefaultConfigValue = {
	defaultRadiusMeters: 1_500,
	maximumRadiusMeters: 10_000,
	areaCode: "NATIONWIDE",
};
const DEFAULT_CLIENTS: MinimumClientVersionConfigValue = { android: "0.1.1" };

function copyValue<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function formatTime(value: string): string {
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp)
		? new Intl.DateTimeFormat("zh-CN", {
				dateStyle: "medium",
				timeStyle: "short",
			}).format(timestamp)
		: "时间不可用";
}

function reasonLabel(reason: AdminConfigRecord["changeReason"]): string {
	if (reason === "ROLLBACK") return "版本回滚";
	return REASON_OPTIONS.find((item) => item.value === reason)?.label ?? reason;
}

function summarizeRecord(record: AdminConfigRecord): string {
	switch (record.configKey) {
		case "features.ai-assistance":
			return record.value.enabled ? "AI 辅助开启" : "AI 辅助关闭";
		case "recommendations.rules":
			return `仅授权增强模式生效 · 基础权重 95 · 运营调节上限 ${record.value.operationsAdjustmentMaximum}`;
		case "recommendations.prompt":
			return `${record.value.enabled ? "开启" : "关闭"} · ${record.value.modelVersion} · ${record.value.timeoutMs} ms`;
		case "coverage.default":
			return `${record.value.areaCode} · 客户端建议 ${record.value.defaultRadiusMeters} m · 服务端上限 ${record.value.maximumRadiusMeters} m`;
		case "clients.minimum-version":
			return `Android ${record.value.android}${record.value.ios === undefined ? "" : ` · iOS ${record.value.ios}`}${record.value.miniprogram === undefined ? "" : ` · 小程序 ${record.value.miniprogram}`}`;
	}
}

function recordFor<K extends AdminConfigKey>(
	records: AdminConfigRecord[],
	configKey: K,
): RecordFor<K> | undefined {
	return records.find((record) => record.configKey === configKey) as
		| RecordFor<K>
		| undefined;
}

function numberInputValue(value: number): number | "" {
	return Number.isFinite(value) ? value : "";
}

function setOptionalClientVersion(
	value: MinimumClientVersionConfigValue,
	key: "ios" | "miniprogram",
	nextValue: string,
): MinimumClientVersionConfigValue {
	const next = { ...value };
	if (nextValue === "") delete next[key];
	else next[key] = nextValue;
	return next;
}

function ToggleField({
	id,
	label,
	description,
	checked,
	disabled,
	onChange,
}: {
	id: string;
	label: string;
	description: string;
	checked: boolean;
	disabled: boolean;
	onChange(value: boolean): void;
}) {
	return (
		<label className="toggle-field" htmlFor={id}>
			<span>
				<strong>{label}</strong>
				<small>{description}</small>
			</span>
			<span className="toggle-control">
				<input
					id={id}
					type="checkbox"
					checked={checked}
					disabled={disabled}
					onChange={(event) => onChange(event.currentTarget.checked)}
				/>
				<span aria-hidden="true" />
			</span>
		</label>
	);
}

function Field({
	id,
	label,
	hint,
	children,
}: {
	id: string;
	label: string;
	hint: string;
	children: ReactNode;
}) {
	return (
		<div className="config-field">
			<label htmlFor={id}>{label}</label>
			{children}
			<small>{hint}</small>
		</div>
	);
}

function AiFields({
	value,
	disabled,
	onChange,
}: {
	value: AiAssistanceConfigValue;
	disabled: boolean;
	onChange(value: AiAssistanceConfigValue): void;
}) {
	return (
		<div className="config-fields">
			<ToggleField
				id="ai-enabled"
				label="启用 AI 辅助"
				description="规则仍负责事实与安全边界；关闭时使用确定性回退。当前没有稳定用户分桶，因此这里只提供全局开关。"
				checked={value.enabled}
				disabled={disabled}
				onChange={(enabled) => onChange({ enabled })}
			/>
		</div>
	);
}

function RulesFields({
	value,
	disabled,
	onChange,
}: {
	value: RecommendationRulesConfigValue;
	disabled: boolean;
	onChange(value: RecommendationRulesConfigValue): void;
}) {
	const total =
		value.qualityWeight +
		value.timeWeight +
		value.budgetWeight +
		value.intentWeight +
		value.diversityWeight;
	const inputs: Array<{
		key: keyof RecommendationRulesConfigValue;
		label: string;
		hint: string;
		max: number;
	}> = [
		{
			key: "qualityWeight",
			label: "质量权重",
			hint: "候选质量的基础权重",
			max: 95,
		},
		{
			key: "timeWeight",
			label: "时间权重",
			hint: "通勤与等待时间的基础权重",
			max: 95,
		},
		{
			key: "budgetWeight",
			label: "预算权重",
			hint: "价格适配的基础权重",
			max: 95,
		},
		{
			key: "intentWeight",
			label: "意图权重",
			hint: "用户当次意图的基础权重",
			max: 95,
		},
		{
			key: "diversityWeight",
			label: "多样性权重",
			hint: "减少重复候选的基础权重",
			max: 95,
		},
		{
			key: "operationsAdjustmentMaximum",
			label: "运营调节上限",
			hint: "0–5，限制人工运营调整影响",
			max: 5,
		},
	];
	return (
		<div className="config-fields rules-fields">
			<p className="field-hint">
				仅当当次响应的数据权益模式为 LICENSED_ENRICHMENT 时，下列加权排序参数才会生效；LIVE_DISPLAY_ONLY 保持上游顺序。
			</p>
			<div
				className={`weight-total ${Math.abs(total - 95) <= 0.0001 ? "weight-valid" : "weight-invalid"}`}
			>
				<span>前五项合计</span>
				<strong>{Number.isFinite(total) ? total : "—"} / 95</strong>
			</div>
			<div className="field-grid">
				{inputs.map((input) => (
					<Field
						id={`rule-${input.key}`}
						key={input.key}
						label={input.label}
						hint={input.hint}
					>
						<input
							id={`rule-${input.key}`}
							type="number"
							min={0}
							max={input.max}
							step="0.0001"
							value={numberInputValue(value[input.key])}
							disabled={disabled}
							onChange={(event) =>
								onChange({
									...value,
									[input.key]: event.currentTarget.valueAsNumber,
								})
							}
						/>
					</Field>
				))}
			</div>
		</div>
	);
}

function PromptFields({
	value,
	disabled,
	onChange,
}: {
	value: RecommendationPromptConfigValue;
	disabled: boolean;
	onChange(value: RecommendationPromptConfigValue): void;
}) {
	return (
		<div className="config-fields">
			<ToggleField
				id="prompt-enabled"
				label="启用提示词链路"
				description="只切换受控提示词版本，不允许在后台输入任意提示词正文。"
				checked={value.enabled}
				disabled={disabled}
				onChange={(enabled) => onChange({ ...value, enabled })}
			/>
			<div className="field-grid">
				<Field
					id="prompt-version"
					label="提示词版本"
					hint="只能选择当前服务端构建已注册的受控提示词。"
				>
					<select
						id="prompt-version"
						value={value.promptVersion}
						disabled={disabled}
						onChange={(event) =>
							onChange({
								...value,
								promptVersion: event.currentTarget
									.value as RecommendationPromptConfigValue["promptVersion"],
							})
						}
					>
						{ADMIN_REGISTERED_PROMPT_VERSIONS.map((version) => (
							<option key={version} value={version}>{version}</option>
						))}
					</select>
				</Field>
				<Field
					id="model-version"
					label="模型版本"
					hint="选择已由服务端部署的版本标签；不包含 API Key。"
				>
					<select
						id="model-version"
						value={value.modelVersion}
						disabled={disabled}
						onChange={(event) =>
							onChange({
								...value,
								modelVersion: event.currentTarget
									.value as RecommendationPromptConfigValue["modelVersion"],
							})
						}
					>
						{ADMIN_REGISTERED_MODEL_VERSIONS.map((version) => (
							<option key={version} value={version}>{version}</option>
						))}
					</select>
				</Field>
				<Field
					id="prompt-timeout"
					label="调用超时"
					hint="500–2500 毫秒；超时后由服务端安全回退。"
				>
					<div className="number-with-unit">
						<input
							id="prompt-timeout"
							type="number"
							min={500}
							max={2500}
							step={1}
							value={numberInputValue(value.timeoutMs)}
							disabled={disabled}
							onChange={(event) =>
								onChange({
									...value,
									timeoutMs: event.currentTarget.valueAsNumber,
								})
							}
						/>
						<span>ms</span>
					</div>
				</Field>
			</div>
		</div>
	);
}

function CoverageFields({
	value,
	disabled,
	onChange,
}: {
	value: CoverageDefaultConfigValue;
	disabled: boolean;
	onChange(value: CoverageDefaultConfigValue): void;
}) {
	return (
		<div className="config-fields field-grid">
			<Field
				id="coverage-area"
				label="默认区域"
				hint="当前管理界面只允许全国范围；更细区域需先补数据权利与产品评审。"
			>
				<select
					id="coverage-area"
					value={value.areaCode}
					disabled={disabled}
					onChange={(event) =>
						onChange({
							...value,
							areaCode: event.currentTarget.value as "NATIONWIDE",
						})
					}
				>
					<option value="NATIONWIDE">全国（NATIONWIDE）</option>
				</select>
			</Field>
			<Field
				id="coverage-default-radius"
				label="客户端建议半径"
				hint="仅供客户端在用户尚未明确选择时建议；服务端仍要求每个推荐请求显式提交 radiusMeters。"
			>
				<div className="number-with-unit">
					<input
						id="coverage-default-radius"
						type="number"
						min={200}
						max={10000}
						step={100}
						value={numberInputValue(value.defaultRadiusMeters)}
						disabled={disabled}
						onChange={(event) =>
							onChange({
								...value,
								defaultRadiusMeters: event.currentTarget.valueAsNumber,
							})
						}
					/>
					<span>m</span>
				</div>
			</Field>
			<Field
				id="coverage-maximum-radius"
				label="最大搜索半径"
				hint="200–10000 米，是扩圈的硬上限。"
			>
				<div className="number-with-unit">
					<input
						id="coverage-maximum-radius"
						type="number"
						min={200}
						max={10000}
						step={100}
						value={numberInputValue(value.maximumRadiusMeters)}
						disabled={disabled}
						onChange={(event) =>
							onChange({
								...value,
								maximumRadiusMeters: event.currentTarget.valueAsNumber,
							})
						}
					/>
					<span>m</span>
				</div>
			</Field>
		</div>
	);
}

function ClientFields({
	value,
	disabled,
	onChange,
}: {
	value: MinimumClientVersionConfigValue;
	disabled: boolean;
	onChange(value: MinimumClientVersionConfigValue): void;
}) {
	return (
		<div className="config-fields field-grid">
			<Field
				id="android-minimum-version"
				label="Android 最低版本"
				hint="必填，严格使用 x.y.z；提升后旧客户端可能被阻断。"
			>
				<input
					id="android-minimum-version"
					type="text"
					inputMode="numeric"
					maxLength={64}
					value={value.android}
					disabled={disabled}
					onChange={(event) =>
						onChange({ ...value, android: event.currentTarget.value })
					}
				/>
			</Field>
			<Field
				id="ios-minimum-version"
				label="iOS 最低版本"
				hint="可选；尚未发布 iOS 客户端时保持空白。"
			>
				<input
					id="ios-minimum-version"
					type="text"
					inputMode="numeric"
					maxLength={64}
					value={value.ios ?? ""}
					disabled={disabled}
					onChange={(event) =>
						onChange(
							setOptionalClientVersion(value, "ios", event.currentTarget.value),
						)
					}
				/>
			</Field>
			<Field
				id="miniprogram-minimum-version"
				label="小程序最低版本"
				hint="可选；尚未发布小程序时保持空白。"
			>
				<input
					id="miniprogram-minimum-version"
					type="text"
					inputMode="numeric"
					maxLength={64}
					value={value.miniprogram ?? ""}
					disabled={disabled}
					onChange={(event) =>
						onChange(
							setOptionalClientVersion(
								value,
								"miniprogram",
								event.currentTarget.value,
							),
						)
					}
				/>
			</Field>
		</div>
	);
}

interface ConfigCardProps<K extends AdminConfigKey> {
	configKey: K;
	title: string;
	description: string;
	impact: string;
	defaultValue: AdminConfigValueMap[K];
	record: RecordFor<K> | undefined;
	canWrite: boolean;
	workspaceBusy: boolean;
	editor(
		value: AdminConfigValueMap[K],
		disabled: boolean,
		onChange: (value: AdminConfigValueMap[K]) => void,
	): ReactNode;
	validate(value: AdminConfigValueMap[K]): string | null;
	onSaved(record: AdminConfigRecord): void;
	onReload(configKey: K): Promise<boolean>;
	onDirtyChange(configKey: K, dirty: boolean): void;
}

function ConfigCard<K extends AdminConfigKey>({
	configKey,
	title,
	description,
	impact,
	defaultValue,
	record,
	canWrite,
	workspaceBusy,
	editor,
	validate,
	onSaved,
	onReload,
	onDirtyChange,
}: ConfigCardProps<K>) {
	const [draft, setDraft] = useState<AdminConfigValueMap[K]>(() =>
		copyValue(
			record === undefined
				? defaultValue
				: (record.value as AdminConfigValueMap[K]),
		),
	);
	const [reason, setReason] = useState<AdminConfigUpdateReason>(
		configKey === "clients.minimum-version"
			? "RELEASE_COMPATIBILITY"
			: "ROUTINE_TUNING",
	);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<Notice | null>(null);
	const [conflicted, setConflicted] = useState(false);
	const [history, setHistory] = useState<AdminConfigRecord[] | null>(null);
	const [historyBusy, setHistoryBusy] = useState(false);
	const [historyError, setHistoryError] = useState<string | null>(null);
	const validationError = validate(draft);
	const baseline = record?.value ?? defaultValue;
	const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
	const controlsBusy = busy || workspaceBusy;
	const definition = ADMIN_CONFIG_DEFINITIONS[configKey];

	useEffect(() => {
		setDraft(
			copyValue(
				record === undefined
					? defaultValue
					: (record.value as AdminConfigValueMap[K]),
			),
		);
	}, [defaultValue, record]);

	useEffect(() => {
		onDirtyChange(configKey, dirty);
	}, [configKey, dirty, onDirtyChange]);

	const loadHistory = useCallback(async () => {
		if (historyBusy) return;
		setHistoryBusy(true);
		setHistoryError(null);
		try {
			const page = await loadAdminConfigurationHistory(configKey, 20);
			setHistory(page.items);
		} catch (error) {
			setHistoryError(
				error instanceof AdminClientError ? error.message : "无法读取历史版本",
			);
		} finally {
			setHistoryBusy(false);
		}
	}, [configKey, historyBusy]);

	async function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!canWrite || validationError !== null || controlsBusy) return;
		setBusy(true);
		setNotice(null);
		setConflicted(false);
		try {
			const updated = await updateAdminConfiguration(configKey, {
				expectedActiveVersion: record?.version ?? null,
				value: draft,
				changeReason: reason,
			});
			onSaved(updated);
			setNotice({
				tone: "success",
				text: `版本 v${updated.version} 已激活，变更已进入审计链路。`,
			});
			if (history !== null) void loadHistory();
		} catch (error) {
			if (error instanceof AdminClientError && error.status === 409) {
				setConflicted(true);
				setNotice({
					tone: "error",
					text: "另一位管理员已更新此配置。你的输入仍保留；请重新加载最新版本，核对后再保存。",
				});
			} else {
				setNotice({
					tone: "error",
					text:
						error instanceof AdminClientError ? error.message : "配置保存失败",
				});
			}
		} finally {
			setBusy(false);
		}
	}

	async function reloadLatest() {
		setBusy(true);
		const loaded = await onReload(configKey);
		setBusy(false);
		if (loaded) {
			setConflicted(false);
			setNotice({
				tone: "info",
				text: "已载入服务器最新版本，请重新核对字段后保存。",
			});
		}
	}

	async function rollback(targetVersion: number) {
		if (
			!canWrite ||
			controlsBusy ||
			record === undefined ||
			record.version === targetVersion
		)
			return;
		if (
			!window.confirm(
				`确认将“${title}”回滚到 v${targetVersion}？系统会创建新的激活版本，不会删除历史。`,
			)
		)
			return;
		setBusy(true);
		setNotice(null);
		try {
			const updated = await rollbackAdminConfiguration(configKey, {
				expectedActiveVersion: record.version,
				targetVersion,
				changeReason: "ROLLBACK",
			});
			onSaved(updated);
			setNotice({
				tone: "success",
				text: `已从 v${targetVersion} 创建并激活回滚版本 v${updated.version}。`,
			});
			await loadHistory();
		} catch (error) {
			if (error instanceof AdminClientError && error.status === 409) {
				setConflicted(true);
				setNotice({
					tone: "error",
					text: "回滚前配置已发生变化。请重新加载最新版本，确认目标后再操作。",
				});
			} else {
				setNotice({
					tone: "error",
					text:
						error instanceof AdminClientError ? error.message : "版本回滚失败",
				});
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<article className="configuration-card" id={`config-${configKey}`}>
			<header className="configuration-card-header">
				<div>
					<p className="eyebrow">{configKey}</p>
					<h2>{title}</h2>
					<p>{description}</p>
				</div>
				<div className="config-meta-badges">
					<span
						className={`status ${definition.classification === "INTERNAL" ? "status-internal" : "status-public"}`}
					>
						{definition.classification === "INTERNAL"
							? "内部配置"
							: "公开运行项"}
					</span>
					<span
						className={`status ${record === undefined ? "status-unavailable" : "status-on"}`}
					>
						{record === undefined ? "未发布" : `v${record.version} 已激活`}
					</span>
				</div>
			</header>
			<div className="config-context">
				<dl>
					<div>
						<dt>当前来源</dt>
						<dd>
							{record === undefined
								? `安全编辑模板 · ${definition.configSchema}（不代表运行值）`
								: `管理配置库 · ${definition.configSchema}`}
						</dd>
					</div>
					<div>
						<dt>最近激活</dt>
						<dd>
							{record === undefined
								? "尚无管理版本"
								: formatTime(record.activatedAt)}
						</dd>
					</div>
					<div>
						<dt>影响提示</dt>
						<dd>{impact}</dd>
					</div>
				</dl>
			</div>
			<form onSubmit={(event) => void save(event)}>
				<fieldset
					className="configuration-fieldset"
					disabled={controlsBusy || !canWrite}
				>
					<legend className="sr-only">编辑{title}</legend>
					{editor(draft, controlsBusy || !canWrite, setDraft)}
					<div className="save-row">
						<label className="reason-field">
							<span>更改原因</span>
							<select
								value={reason}
								disabled={controlsBusy || !canWrite}
								onChange={(event) =>
									setReason(
										event.currentTarget.value as AdminConfigUpdateReason,
									)
								}
							>
								{REASON_OPTIONS.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label} · {option.help}
									</option>
								))}
							</select>
						</label>
						<div className="save-actions">
							{dirty && <span className="unsaved-dot">有未保存更改</span>}
							<button
								className="primary-button"
								type="submit"
								disabled={
									!canWrite ||
									controlsBusy ||
									validationError !== null ||
									(!dirty && record !== undefined)
								}
							>
								{controlsBusy
									? "处理中…"
									: record === undefined
										? "发布首个版本"
										: "保存并激活"}
							</button>
						</div>
					</div>
				</fieldset>
			</form>
			{!canWrite && (
				<p className="permission-hint">
					当前会话只有 ALGORITHM_CONFIG_READ；字段保持只读，需
					ALGORITHM_CONFIG_WRITE 才能保存或回滚。
				</p>
			)}
			{validationError !== null && (
				<p className="form-message form-error" role="alert">
					{validationError}
				</p>
			)}
			{notice !== null && (
				<div
					className={`form-message notice-${notice.tone}`}
					role={notice.tone === "error" ? "alert" : "status"}
				>
					<span>{notice.text}</span>
					{conflicted && (
						<button
							className="inline-button"
							type="button"
							disabled={controlsBusy}
							onClick={() => void reloadLatest()}
						>
							重新加载最新版本
						</button>
					)}
				</div>
			)}
			<details
				className="history-panel"
				onToggle={(event) => {
					if (event.currentTarget.open && history === null && !historyBusy)
						void loadHistory();
				}}
			>
				<summary>
					<span>历史版本</span>
					<small>展开后按需读取最近 20 个版本</small>
				</summary>
				<div className="history-content">
					{historyBusy && <p aria-live="polite">正在读取历史版本…</p>}
					{historyError !== null && (
						<p className="form-message form-error" role="alert">
							{historyError}
						</p>
					)}
					{!historyBusy && history !== null && history.length === 0 && (
						<p>尚无历史版本。</p>
					)}
					{history !== null && history.length > 0 && (
						<ol className="history-list">
							{history.map((item) => (
								<li key={item.version}>
									<div>
										<strong>
											v{item.version}
											{item.version === record?.version ? " · 当前" : ""}
										</strong>
										<span>
											{formatTime(item.activatedAt)} ·{" "}
											{reasonLabel(item.changeReason)}
										</span>
										<small>{summarizeRecord(item)}</small>
									</div>
									<button
										className="quiet-button compact"
										type="button"
										disabled={
											!canWrite || controlsBusy || item.version === record?.version
										}
										onClick={() => void rollback(item.version)}
									>
										{item.version === record?.version
											? "当前版本"
											: "回滚到此版本"}
									</button>
								</li>
							))}
						</ol>
					)}
				</div>
			</details>
		</article>
	);
}

function validateRules(value: RecommendationRulesConfigValue): string | null {
	const values = [
		value.qualityWeight,
		value.timeWeight,
		value.budgetWeight,
		value.intentWeight,
		value.diversityWeight,
	];
	if (
		values.some(
			(item) =>
				!Number.isFinite(item) ||
				item < 0 ||
				item > 95 ||
				Math.abs(item * 10_000 - Math.round(item * 10_000)) >= 1e-7,
		)
	)
		return "五项基础权重必须在 0–95 之间，最多四位小数。";
	if (Math.abs(values.reduce((sum, item) => sum + item, 0) - 95) > 0.000001)
		return "质量、时间、预算、意图与多样性权重之和必须为 95。";
	if (
		!Number.isFinite(value.operationsAdjustmentMaximum) ||
		value.operationsAdjustmentMaximum < 0 ||
		value.operationsAdjustmentMaximum > 5 ||
		Math.abs(
			value.operationsAdjustmentMaximum * 10_000 -
				Math.round(value.operationsAdjustmentMaximum * 10_000),
		) >= 1e-7
	)
		return "运营调节上限必须在 0–5 之间，最多四位小数。";
	return null;
}

function validatePrompt(value: RecommendationPromptConfigValue): string | null {
	if (!ADMIN_REGISTERED_PROMPT_VERSIONS.includes(value.promptVersion))
		return "提示词版本未在当前服务端构建注册。";
	if (!ADMIN_REGISTERED_MODEL_VERSIONS.includes(value.modelVersion))
		return "模型版本未在当前服务端构建注册。";
	if (
		!Number.isSafeInteger(value.timeoutMs) ||
		value.timeoutMs < 500 ||
		value.timeoutMs > 2_500
	)
		return "调用超时必须是 500–2500 毫秒的整数。";
	return null;
}

function validateCoverage(value: CoverageDefaultConfigValue): string | null {
	if (value.areaCode !== "NATIONWIDE") return "当前管理界面只允许 NATIONWIDE。";
	if (
		!Number.isSafeInteger(value.defaultRadiusMeters) ||
		value.defaultRadiusMeters < 200 ||
		value.defaultRadiusMeters > 10_000
	)
		return "默认半径必须是 200–10000 米的整数。";
	if (
		!Number.isSafeInteger(value.maximumRadiusMeters) ||
		value.maximumRadiusMeters < 200 ||
		value.maximumRadiusMeters > 10_000
	)
		return "最大半径必须是 200–10000 米的整数。";
	if (value.defaultRadiusMeters > value.maximumRadiusMeters)
		return "默认半径不能大于最大半径。";
	return null;
}

function validateClients(
	value: MinimumClientVersionConfigValue,
): string | null {
	const semver = /^(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})$/;
	if (!semver.test(value.android))
		return "Android 最低版本必须是严格的 x.y.z。";
	if (value.ios !== undefined && !semver.test(value.ios))
		return "iOS 最低版本必须留空或使用严格的 x.y.z。";
	if (value.miniprogram !== undefined && !semver.test(value.miniprogram))
		return "小程序最低版本必须留空或使用严格的 x.y.z。";
	return null;
}

export function ConfigurationWorkspace() {
	const { hasPermission } = useAdminSession();
	const canRead = hasPermission("ALGORITHM_CONFIG_READ");
	const canWrite = hasPermission("ALGORITHM_CONFIG_WRITE");
	const [records, setRecords] = useState<AdminConfigRecord[]>([]);
	const [busy, setBusy] = useState(canRead);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [loadedAt, setLoadedAt] = useState<string | null>(null);
	const [dirtyKeys, setDirtyKeys] = useState<ReadonlySet<AdminConfigKey>>(
		() => new Set(),
	);

	const refresh = useCallback(async (): Promise<boolean> => {
		if (!canRead) return false;
		setBusy(true);
		setLoadError(null);
		try {
			const page = await loadAdminConfiguration();
			setRecords(page.items);
			setLoadedAt(
				new Intl.DateTimeFormat("zh-CN", { timeStyle: "medium" }).format(
					new Date(),
				),
			);
			return true;
		} catch (error) {
			setLoadError(
				error instanceof AdminClientError ? error.message : "无法读取管理配置",
			);
			return false;
		} finally {
			setBusy(false);
		}
	}, [canRead]);

	const refreshRecord = useCallback(
		async (configKey: AdminConfigKey): Promise<boolean> => {
			if (!canRead) return false;
			setBusy(true);
			setLoadError(null);
			try {
				const page = await loadAdminConfiguration();
				setRecords((current) =>
					replaceReloadedConfigurationRecord(current, page.items, configKey),
				);
				setLoadedAt(
					new Intl.DateTimeFormat("zh-CN", { timeStyle: "medium" }).format(
						new Date(),
					),
				);
				return true;
			} catch (error) {
				setLoadError(
					error instanceof AdminClientError ? error.message : "无法读取管理配置",
				);
				return false;
			} finally {
				setBusy(false);
			}
		},
		[canRead],
	);

	useEffect(() => {
		if (canRead) void refresh();
	}, [canRead, refresh]);

	const updateRecord = useCallback((next: AdminConfigRecord) => {
		setRecords((current) => [
			next,
			...current.filter((item) => item.configKey !== next.configKey),
		]);
	}, []);

	const updateDirtyState = useCallback(
		(configKey: AdminConfigKey, dirty: boolean) => {
			setDirtyKeys((current) =>
				updateDirtyConfigKeys(current, configKey, dirty),
			);
		},
		[],
	);

	function confirmAndRefreshAll() {
		if (
			dirtyKeys.size > 0 &&
			!window.confirm(
				`当前有 ${dirtyKeys.size} 个分组存在未保存更改。确认放弃这些草稿并刷新全部配置吗？`,
			)
		)
			return;
		void refresh();
	}

	const activeCount = records.length;
	const loadedSummary = useMemo(() => {
		if (busy) return "正在读取…";
		if (loadError !== null) return "读取失败";
		return `${activeCount}/5 已发布${loadedAt === null ? "" : ` · ${loadedAt} 更新`}`;
	}, [activeCount, busy, loadError, loadedAt]);

	if (!canRead) {
		return (
			<aside className="read-only-note">
				<strong>没有配置读取权限</strong>
				<p>
					配置内容未加载。请由安全管理员按最小权限分配 ALGORITHM_CONFIG_READ。
				</p>
			</aside>
		);
	}

	return (
		<>
			<section className="configuration-summary panel" aria-live="polite">
				<div>
					<p className="eyebrow">权限与版本</p>
					<h2>{loadedSummary}</h2>
					<p>
						读取与写入均由服务端 RBAC
						逐请求复核；页面只保留版本号和当前表单状态。
					</p>
				</div>
				<div className="config-meta-badges">
					<span className="status status-on">可读取</span>
					<span className={`status ${canWrite ? "status-on" : "status-off"}`}>
						{canWrite ? "可写入" : "只读"}
					</span>
					<button
						className="quiet-button compact"
						type="button"
						disabled={busy}
						onClick={confirmAndRefreshAll}
					>
						{busy ? "刷新中…" : "刷新全部"}
					</button>
				</div>
			</section>
			{loadError !== null && (
				<p className="form-message form-error" role="alert">
					{loadError}
				</p>
			)}
			<div className="configuration-layout">
				<aside className="configuration-index" aria-label="配置分组导航">
					<p>配置分组</p>
					<nav>
						{CONFIG_GROUPS.map((group) => (
							<a key={group.key} href={`#config-${group.key}`}>
								<span aria-hidden="true">{group.short}</span>
								{group.label}
							</a>
						))}
					</nav>
					<small>每次只保存一个分组，便于审计、回滚和冲突处理。</small>
				</aside>
				<section className="configuration-stack" aria-label="可编辑配置">
					<ConfigCard<"features.ai-assistance">
						configKey="features.ai-assistance"
						title="AI 辅助开关"
						description="控制 AI 辅助是否参与决策。当前没有稳定用户分桶，因此不提供灰度比例。"
						impact="影响推荐决策路径；不会改变事实字段或数据授权边界。"
						defaultValue={DEFAULT_AI}
						record={recordFor(records, "features.ai-assistance")}
						canWrite={canWrite}
						workspaceBusy={busy}
						editor={(value, disabled, onChange) => (
							<AiFields value={value} disabled={disabled} onChange={onChange} />
						)}
						validate={() => null}
						onSaved={updateRecord}
						onReload={refreshRecord}
						onDirtyChange={updateDirtyState}
					/>
					<ConfigCard<"recommendations.rules">
						configKey="recommendations.rules"
						title="推荐规则权重"
						description="通过固定字段调整质量、时间、预算、意图与多样性权重；仅 LICENSED_ENRICHMENT 使用。"
						impact="仅影响已逐数据源获授权的增强排序；LIVE_DISPLAY_ONLY 不计算加权适配度，并保持上游顺序。"
						defaultValue={DEFAULT_RULES}
						record={recordFor(records, "recommendations.rules")}
						canWrite={canWrite}
						workspaceBusy={busy}
						editor={(value, disabled, onChange) => (
							<RulesFields
								value={value}
								disabled={disabled}
								onChange={onChange}
							/>
						)}
						validate={validateRules}
						onSaved={updateRecord}
						onReload={refreshRecord}
						onDirtyChange={updateDirtyState}
					/>
					<ConfigCard<"recommendations.prompt">
						configKey="recommendations.prompt"
						title="提示词与模型版本"
						description="选择已在服务端受控部署的提示词、模型版本和超时，不允许输入任意提示词正文。"
						impact="影响 AI 辅助输出与回退频率；第三方密钥和完整提示词始终留在服务端。"
						defaultValue={DEFAULT_PROMPT}
						record={recordFor(records, "recommendations.prompt")}
						canWrite={canWrite}
						workspaceBusy={busy}
						editor={(value, disabled, onChange) => (
							<PromptFields
								value={value}
								disabled={disabled}
								onChange={onChange}
							/>
						)}
						validate={validatePrompt}
						onSaved={updateRecord}
						onReload={refreshRecord}
						onDirtyChange={updateDirtyState}
					/>
					<ConfigCard<"coverage.default">
						configKey="coverage.default"
						title="默认覆盖范围"
						description="配置客户端建议半径、服务端最大扩圈边界与固定全国区域编码。"
						impact="影响候选查询范围、响应时延和第三方配额；不改变数据权益模式。"
						defaultValue={DEFAULT_COVERAGE}
						record={recordFor(records, "coverage.default")}
						canWrite={canWrite}
						workspaceBusy={busy}
						editor={(value, disabled, onChange) => (
							<CoverageFields
								value={value}
								disabled={disabled}
								onChange={onChange}
							/>
						)}
						validate={validateCoverage}
						onSaved={updateRecord}
						onReload={refreshRecord}
						onDirtyChange={updateDirtyState}
					/>
					<ConfigCard<"clients.minimum-version">
						configKey="clients.minimum-version"
						title="最低客户端版本"
						description="按平台设置仍可访问服务的最低版本；未发布的平台保持空白。"
						impact="提升版本可能立即阻断旧客户端，应先确认商店发布、灰度和回滚路径。"
						defaultValue={DEFAULT_CLIENTS}
						record={recordFor(records, "clients.minimum-version")}
						canWrite={canWrite}
						workspaceBusy={busy}
						editor={(value, disabled, onChange) => (
							<ClientFields
								value={value}
								disabled={disabled}
								onChange={onChange}
							/>
						)}
						validate={validateClients}
						onSaved={updateRecord}
						onReload={refreshRecord}
						onDirtyChange={updateDirtyState}
					/>
				</section>
			</div>
		</>
	);
}

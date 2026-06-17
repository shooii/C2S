import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Result,
  Space,
  Spin,
  Tree,
  Tooltip,
  Typography
} from "antd";
import {
  ArrowLeftOutlined,
  DownloadOutlined
} from "@ant-design/icons";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../../services/api";
import { TaskStatusTag } from "../../components/StatusTag";
import type { PreviewPayload, ResultFile } from "../../types";

export default function Preview() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const fileId = searchParams.get("fileId") || undefined;
  const [loading, setLoading] = useState(true);
  const [payload, setPayload] = useState<PreviewPayload | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!taskId) return;
    let disposed = false;
    const load = async () => {
      setLoading(true);
      setLoadError("");
      try {
        const nextPayload = await api.getPreview(taskId, fileId);
        if (!disposed) {
          setPayload(nextPayload);
        }
      } catch (error) {
        if (!disposed) {
          setPayload(null);
          setLoadError(error instanceof Error ? error.message : "预览数据加载失败");
        }
      } finally {
        if (!disposed) {
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      disposed = true;
    };
  }, [fileId, reloadToken, taskId]);

  const sceneStats = useMemo(() => ({
    files: payload?.files.length || 0,
    bytes: payload?.files.reduce((sum, file) => sum + file.fileSize, 0) || 0,
    previewType: payload?.type || "-",
    taskStatus: payload?.task.status || "-"
  }), [payload]);

  if (loading) {
    return (
      <div className="center-state">
        <Spin />
      </div>
    );
  }

  if (!payload) {
    if (loadError) {
      return (
        <Result
          status="error"
          title="预览加载失败"
          subTitle={loadError}
          extra={[
            <Button key="back" onClick={() => navigate(`/results/${taskId}`)}>返回任务详情</Button>,
            <Button key="retry" type="primary" onClick={() => setReloadToken((value) => value + 1)}>
              重试
            </Button>
          ]}
        />
      );
    }
    return <Empty description="预览数据不存在" />;
  }

  return (
    <div className="page-stack">
      <div className="toolbar">
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(`/results/${taskId}`)}>返回</Button>
          <Space direction="vertical" size={0}>
            <Typography.Title level={4} style={{ margin: 0 }}>
              在线预览
            </Typography.Title>
            <Typography.Text type="secondary">{payload.task.taskName}</Typography.Text>
          </Space>
        </Space>
      </div>

      <div className="preview-shell">
        {loadError && (
          <Alert
            className="preview-load-alert"
            type="error"
            showIcon
            message="切换预览文件失败"
            description={loadError}
            action={<Button size="small" onClick={() => setReloadToken((value) => value + 1)}>重试</Button>}
          />
        )}
        <div className="preview-panel preview-side preview-files-panel">
          <Typography.Title level={5}>成果文件</Typography.Title>
          {payload.files.length ? (
            <Tree
              defaultExpandAll
              selectedKeys={payload.file ? [payload.file.id] : []}
              onSelect={(keys) => {
                const selectedFileId = keys[0];
                if (selectedFileId && String(selectedFileId) !== payload.file?.id) {
                  setSearchParams({ fileId: String(selectedFileId) });
                }
              }}
              treeData={payload.files.map((file) => ({
                key: file.id,
                title: (
                  <Tooltip title={previewFileTooltip(file)}>
                    <span className={`preview-file-title${file.previewable ? "" : " is-unsupported"}`}>
                      {file.fileName} ({formatSize(file.fileSize)})
                    </span>
                  </Tooltip>
                )
              }))}
            />
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无成果文件" />
          )}
        </div>

        <div className="preview-panel preview-stage">
          <PreviewStage payload={payload} />
        </div>

        <div className="preview-panel preview-side preview-info-panel">
          <Typography.Title level={5}>文件信息</Typography.Title>
          <Card
            size="small"
            title="当前成果"
            extra={payload.file?.downloadable ? (
              <Button
                type="link"
                size="small"
                icon={<DownloadOutlined />}
                onClick={() => window.open(api.downloadUrl(payload.task.id, payload.file!.id), "_blank")}
              >
                下载
              </Button>
            ) : null}
          >
            <Descriptions size="small" column={1}>
              <Descriptions.Item label="文件名">{payload.file?.fileName || "-"}</Descriptions.Item>
              <Descriptions.Item label="类型">{previewTypeLabel(payload.type)}</Descriptions.Item>
              <Descriptions.Item label="大小">{payload.file ? formatSize(payload.file.fileSize) : "-"}</Descriptions.Item>
              <Descriptions.Item label="任务状态">
                <TaskStatusTag status={payload.task.status} />
              </Descriptions.Item>
            </Descriptions>
          </Card>
          <Typography.Title level={5} style={{ marginTop: 20 }}>操作提示</Typography.Title>
          <Typography.Paragraph type="secondary">
            {previewUsageTip(payload.type, payload.file)}
          </Typography.Paragraph>
        </div>

        <div className="preview-panel preview-bottom">
          <div className="preview-stat"><strong>{sceneStats.files}</strong><span>成果文件</span></div>
          <div className="preview-stat"><strong>{formatSize(sceneStats.bytes)}</strong><span>数据体量</span></div>
          <div className="preview-stat"><strong>{previewTypeLabel(sceneStats.previewType)}</strong><span>预览类型</span></div>
          <div className="preview-stat"><strong>{taskStatusLabel(sceneStats.taskStatus)}</strong><span>任务状态</span></div>
        </div>
      </div>
    </div>
  );
}

function PreviewStage({ payload }: { payload: PreviewPayload }) {
  const url = api.absoluteUrl(payload.url);
  if (payload.type === "gltf" && url) {
    return <ThreeGltfPreview url={url} />;
  }
  if (payload.type === "3dtiles" && url) {
    return <CesiumTilesPreview url={url} />;
  }
  if (payload.type === "json") {
    return <pre className="preview-json">{JSON.stringify(payload.json, null, 2)}</pre>;
  }
  return (
    <div className="center-state">
      <Empty description={payload.message || unsupportedPreviewMessage(payload.file)} />
    </div>
  );
}

function ThreeGltfPreview({ url }: { url: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setStatus("loading");
    setErrorMessage("");

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a1728);
    const camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.1, 1000);
    camera.position.set(8, 6, 8);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x24334a, 2.4));
    const directional = new THREE.DirectionalLight(0xffffff, 2.2);
    directional.position.set(5, 8, 5);
    scene.add(directional);
    const grid = new THREE.GridHelper(24, 24, 0x2a6ecb, 0x27425f);
    scene.add(grid);

    const loader = new GLTFLoader();
    let model: THREE.Object3D | null = null;
    loader.load(url, (gltf) => {
      model = gltf.scene;
      scene.add(model);
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const radius = Number.isFinite(sphere.radius) && sphere.radius > 0 ? sphere.radius : 1;
      const distance = Math.max(radius / Math.sin(THREE.MathUtils.degToRad(camera.fov) / 2), 1);
      model.position.sub(center);
      camera.near = Math.max(distance / 5000, 0.01);
      camera.far = Math.max(distance + radius * 4, 1000);
      camera.updateProjectionMatrix();
      camera.position.copy(new THREE.Vector3(0.9, 0.65, 0.9).normalize().multiplyScalar(distance));
      controls.minDistance = Math.max(radius / 1000, 0.1);
      controls.maxDistance = camera.far * 0.8;
      controls.target.set(0, 0, 0);
      controls.update();
      grid.scale.setScalar(Math.max(radius / 12, 1));
      setStatus("ready");
    }, undefined, (error) => {
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "模型文件加载失败");
    });

    const resizeObserver = new ResizeObserver(() => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    });
    resizeObserver.observe(container);

    let frameId = 0;
    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      frameId = window.requestAnimationFrame(animate);
    };
    animate();

    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [url]);

  return (
    <div className="preview-render-surface">
      <div ref={containerRef} className="full-height" />
      {status === "loading" && <div className="preview-stage-state"><Spin tip="正在加载模型" /></div>}
      {status === "error" && <div className="preview-stage-state"><Empty description={errorMessage} /></div>}
    </div>
  );
}

function CesiumTilesPreview({ url }: { url: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let destroyed = false;
    let viewer: any = null;
    setStatus("loading");
    setErrorMessage("");

    import("cesium").then(async (Cesium) => {
      if (destroyed) return;
      viewer = new Cesium.Viewer(container, {
        animation: false,
        baseLayerPicker: false,
        fullscreenButton: false,
        geocoder: false,
        homeButton: true,
        infoBox: true,
        sceneModePicker: false,
        selectionIndicator: true,
        timeline: false,
        navigationHelpButton: false
      });
      const tileset = await Cesium.Cesium3DTileset.fromUrl(url);
      viewer.scene.primitives.add(tileset);
      await viewer.zoomTo(tileset);
      if (!destroyed) {
        setStatus("ready");
      }
    }).catch((error) => {
      if (!destroyed) {
        setStatus("error");
        setErrorMessage(error instanceof Error ? error.message : "3D Tiles 加载失败");
      }
    });

    return () => {
      destroyed = true;
      viewer?.destroy();
    };
  }, [url]);

  return (
    <div className="preview-render-surface">
      <div ref={containerRef} className="cesium-container" />
      {status === "loading" && <div className="preview-stage-state"><Spin tip="正在加载 3D Tiles" /></div>}
      {status === "error" && <div className="preview-stage-state"><Empty description={errorMessage} /></div>}
    </div>
  );
}

function previewTypeLabel(type: string): string {
  if (type === "gltf") return "glTF / GLB";
  if (type === "3dtiles") return "3D Tiles";
  if (type === "json") return "JSON";
  if (type === "unsupported") return "暂不支持";
  return type || "-";
}

function taskStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: "排队中",
    running: "运行中",
    success: "成功",
    failed: "失败",
    cancelled: "已取消"
  };
  return labels[status] || status || "-";
}

function previewFileTooltip(file: ResultFile): string {
  if (file.previewable) return file.fileName;
  if (file.downloadable) return `${file.fileName}（可查看信息并下载，暂不支持预览）`;
  return `${file.fileName}（暂不支持预览或下载）`;
}

function unsupportedPreviewMessage(file?: ResultFile): string {
  if (!file) return "暂无可预览成果文件";
  if (file.downloadable) return "该成果类型暂不支持在线预览，可下载后查看";
  return "该成果类型暂不支持在线预览，且当前文件不可下载";
}

function previewUsageTip(type: string, file?: ResultFile): string {
  if (type === "gltf") return "按住鼠标左键旋转，滚轮缩放，右键拖动平移视角。";
  if (type === "3dtiles") return "拖动旋转场景，滚轮缩放；可从左侧切换其他可预览成果。";
  if (type === "json") return "当前以格式化文本展示，可滚动查看完整 JSON 内容。";
  if (!file) return "暂无可预览成果文件，可返回任务详情检查成果输出。";
  if (!file.downloadable) return "该文件暂不支持在线预览，也没有可下载文件，可返回任务详情检查成果状态。";
  return "该文件暂不支持在线预览，可使用上方下载入口在本地查看。";
}

function formatSize(value: number): string {
  if (!value) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

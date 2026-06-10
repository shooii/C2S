import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Card,
  Empty,
  Space,
  Spin,
  Tree,
  Typography
} from "antd";
import {
  ArrowLeftOutlined,
  ApartmentOutlined,
  BorderOutlined,
  GatewayOutlined,
  NodeIndexOutlined,
  TagsOutlined
} from "@ant-design/icons";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../../services/api";
import type { PreviewPayload } from "../../types";

const semanticLayers = [
  { key: "building", title: "建筑模型", icon: <ApartmentOutlined /> },
  { key: "road", title: "道路", icon: <NodeIndexOutlined /> },
  { key: "walkable", title: "可通行区域", icon: <BorderOutlined /> },
  { key: "obstacle", title: "障碍物", icon: <BorderOutlined /> },
  { key: "door", title: "门", icon: <GatewayOutlined /> },
  { key: "elevator", title: "电梯", icon: <GatewayOutlined /> },
  { key: "navmesh", title: "导航网格", icon: <NodeIndexOutlined /> },
  { key: "collider", title: "碰撞体", icon: <BorderOutlined /> },
  { key: "semantic", title: "语义标签", icon: <TagsOutlined /> }
];

export default function Preview() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [payload, setPayload] = useState<PreviewPayload | null>(null);

  useEffect(() => {
    if (!taskId) return;
    const load = async () => {
      setLoading(true);
      try {
        setPayload(await api.getPreview(taskId));
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [taskId]);

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
        <div className="preview-panel preview-side">
          <Typography.Title level={5}>成果文件树</Typography.Title>
          <Tree
            defaultExpandAll
            treeData={payload.files.map((file) => ({
              key: file.id,
              title: `${file.fileName} (${formatSize(file.fileSize)})`
            }))}
          />
          <Typography.Title level={5} style={{ marginTop: 20 }}>图层列表</Typography.Title>
          <Space direction="vertical" size={8}>
            {semanticLayers.map((layer) => (
              <Space key={layer.key}>
                {layer.icon}
                <Typography.Text>{layer.title}</Typography.Text>
              </Space>
            ))}
          </Space>
        </div>

        <div className="preview-panel preview-stage">
          <PreviewStage payload={payload} />
        </div>

        <div className="preview-panel preview-side">
          <Typography.Title level={5}>对象属性</Typography.Title>
          <Card size="small" title="当前成果">
            <Space direction="vertical" size={6}>
              <Typography.Text>类型：{payload.type}</Typography.Text>
              <Typography.Text>文件：{payload.file?.fileName || "-"}</Typography.Text>
              <Typography.Text>任务：{payload.task.status}</Typography.Text>
            </Space>
          </Card>
          <Typography.Title level={5} style={{ marginTop: 20 }}>语义标签</Typography.Title>
          <Space wrap>
            {semanticLayers.map((layer) => (
              <Button key={layer.key} size="small">{layer.title}</Button>
            ))}
          </Space>
          <Typography.Title level={5} style={{ marginTop: 20 }}>坐标信息</Typography.Title>
          <Typography.Paragraph type="secondary">
            EPSG / 局部坐标系信息会随结果元数据展示。
          </Typography.Paragraph>
        </div>

        <div className="preview-panel preview-bottom">
          <div className="preview-stat"><strong>{sceneStats.files}</strong><span>成果文件</span></div>
          <div className="preview-stat"><strong>{formatSize(sceneStats.bytes)}</strong><span>数据体量</span></div>
          <div className="preview-stat"><strong>{sceneStats.previewType}</strong><span>预览类型</span></div>
          <div className="preview-stat"><strong>{sceneStats.taskStatus}</strong><span>任务状态</span></div>
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
      <Empty description={payload.message || "该成果类型暂不支持在线预览，可下载后查看"} />
    </div>
  );
}

function ThreeGltfPreview({ url }: { url: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a1728);
    const camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.1, 10000);
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
    scene.add(new THREE.GridHelper(24, 24, 0x2a6ecb, 0x27425f));

    const loader = new GLTFLoader();
    let model: THREE.Object3D | null = null;
    loader.load(url, (gltf) => {
      model = gltf.scene;
      scene.add(model);
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3()).length();
      const center = box.getCenter(new THREE.Vector3());
      model.position.sub(center);
      camera.position.set(size * 0.9, size * 0.65, size * 0.9);
      controls.target.set(0, 0, 0);
      controls.update();
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
      container.removeChild(renderer.domElement);
    };
  }, [url]);

  return <div ref={containerRef} className="full-height" />;
}

function CesiumTilesPreview({ url }: { url: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let destroyed = false;
    let viewer: any = null;

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
    });

    return () => {
      destroyed = true;
      viewer?.destroy();
    };
  }, [url]);

  return <div ref={containerRef} className="cesium-container" />;
}

function formatSize(value: number): string {
  if (!value) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

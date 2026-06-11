import { useEffect, useMemo, useState } from "react";
import {
  App as AntApp,
  Badge,
  Layout,
  Menu,
  Space,
  Tooltip,
  Typography
} from "antd";
import {
  ApartmentOutlined,
  ApiOutlined,
  DatabaseOutlined,
  FileSearchOutlined
} from "@ant-design/icons";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import TemplateManage from "./pages/TemplateManage";
import TemplateConfig from "./pages/TemplateManage/TemplateConfig";
import ResultManage from "./pages/ResultManage";
import ResultDetail from "./pages/ResultManage/ResultDetail";
import Preview from "./pages/Preview";
import { api } from "./services/api";
import type { FmeStatus } from "./types";

const { Header, Sider, Content } = Layout;

function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const { message } = AntApp.useApp();
  const [fmeStatus, setFmeStatus] = useState<FmeStatus | null>(null);

  useEffect(() => {
    api.getFmeStatus()
      .then(setFmeStatus)
      .catch((error) => message.warning(error.message));
  }, [message]);

  const selectedKey = useMemo(() => {
    if (location.pathname.startsWith("/results") || location.pathname.startsWith("/preview")) {
      return "/results";
    }
    return "/templates";
  }, [location.pathname]);

  return (
    <Layout className="app-shell">
      <Sider width={224} className="app-sider">
        <div className="brand-block">
          <ApartmentOutlined />
          <div>
            <Typography.Text className="brand-title">C2S</Typography.Text>
            <Typography.Text className="brand-subtitle">CIM to SIM</Typography.Text>
          </div>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={[
            {
              key: "/templates",
              icon: <DatabaseOutlined />,
              label: "模板管理"
            },
            {
              key: "/results",
              icon: <FileSearchOutlined />,
              label: "任务管理"
            }
          ]}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Content className="app-content">
          <Routes>
            <Route path="/" element={<Navigate to="/templates" replace />} />
            <Route path="/templates" element={<TemplateManage />} />
            <Route path="/templates/:id/config" element={<TemplateConfig />} />
            <Route path="/results" element={<ResultManage />} />
            <Route path="/results/:id" element={<ResultDetail />} />
            <Route path="/preview/:taskId" element={<Preview />} />
            <Route path="*" element={<Navigate to="/templates" replace />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  );
}

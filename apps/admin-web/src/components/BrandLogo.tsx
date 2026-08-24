import { Space, Typography, theme } from 'antd';

const { Text } = Typography;

interface BrandLogoProps {
  size?: 'compact' | 'default' | 'large';
  dark?: boolean;
}

export default function BrandLogo({ size = 'default', dark = false }: BrandLogoProps) {
  const { token } = theme.useToken();
  const isLarge = size === 'large';
  const isCompact = size === 'compact';
  const markSize = isLarge ? 52 : 34;

  return (
    <Space size={isLarge ? 14 : 10} align="center">
      <img
        aria-hidden="true"
        src="/app-icon-192.png"
        alt=""
        style={{
          width: markSize,
          height: markSize,
          // 与小程序头像同一张圆形图，按圆裁
          borderRadius: '50%',
          display: 'block',
          objectFit: 'cover',
          boxShadow: isLarge ? '0 12px 28px rgba(49, 85, 138, 0.2)' : 'none',
        }}
      />
      {!isCompact && (
        <div style={{ lineHeight: 1.1 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 4,
              color: dark ? '#fff' : token.colorText,
              fontWeight: 800,
              fontSize: isLarge ? 26 : 17,
              letterSpacing: 0,
            }}
          >
            <span>邻修</span>
            <span style={{ color: dark ? 'rgba(255,255,255,0.72)' : token.colorTextTertiary }}>•</span>
            <span>零修</span>
          </div>
          <Text
            style={{
              color: dark ? 'rgba(255,255,255,0.76)' : token.colorTextSecondary,
              fontSize: isLarge ? 13 : 12,
            }}
          >
            社区维修与便民服务平台
          </Text>
        </div>
      )}
    </Space>
  );
}

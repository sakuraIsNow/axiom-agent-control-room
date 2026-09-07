import { useEffect, useState } from 'react';
import { Download, ImageOff, LoaderCircle } from 'lucide-react';
import { readTaskMedia, taskMediaPath } from '../../lib/taskMedia';
import { useUiLanguage } from '../../lib/uiLanguage';

export function TaskMedia({ src, alt = '', children }: { src?: string; alt?: string; children?: React.ReactNode }) {
  const path = taskMediaPath(src, window.location.origin);
  const { language } = useUiLanguage();
  const zh = language === 'zh-CN';
  const [media, setMedia] = useState<{ path: string; url?: string; video?: boolean; failed?: boolean } | null>(null);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void readTaskMedia(path, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setMedia({ path, url: objectUrl, video: blob.type.startsWith('video/') });
    }).catch(() => { if (!controller.signal.aborted) setMedia({ path, failed: true }); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [path]);
  if (!path) return children ? <a href={src} target="_blank" rel="noreferrer">{children}</a> : <img src={src} alt={alt} loading="lazy" />;
  const current = media?.path === path ? media : null;
  return <span className="task-media" data-i18n-ignore="true">
    {current?.url ? <>
      {current.video ? <video src={current.url} controls preload="metadata" aria-label={alt || (zh ? '生成的视频' : 'Generated Video')} /> : <img src={current.url} alt={alt} />}
      <a href={current.url} download={current.video ? 'axiom-video.mp4' : 'axiom-image'}><Download size={14} />{zh ? '下载' : 'Download'}</a>
    </> : <span role="status">{current?.failed ? <ImageOff size={16} /> : <LoaderCircle size={16} />}{current?.failed ? (zh ? '文件暂不可用' : 'Media unavailable') : (zh ? '正在读取文件' : 'Loading media')}</span>}
  </span>;
}

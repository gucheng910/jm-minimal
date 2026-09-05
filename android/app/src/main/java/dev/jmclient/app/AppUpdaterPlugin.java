package dev.jmclient.app;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * 更新桥：从 GitHub Release 下载 APK 到应用缓存，再由系统安装器安装
 * （安装未知应用需用户按系统提示授权）
 */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {

  private long taskId = -1;

  private File targetFile() {
    return new File(getContext().getCacheDir(), "jm-update-" + getContext().getPackageName() + ".apk");
  }

  @PluginMethod
  public void download(PluginCall call) {
    String url = call.getString("url");
    if (url == null || url.isEmpty()) {
      call.reject("missing url");
      return;
    }
    try {
      File f = targetFile();
      if (f.exists()) f.delete();
      DownloadManager dm = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
      DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
      req.setDestinationUri(Uri.fromFile(f));
      req.setMimeType("application/vnd.android.package-archive");
      req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
      taskId = dm.enqueue(req);
      JSObject ok = new JSObject();
      ok.put("ok", true);
      call.resolve(ok);
    } catch (Exception e) {
      call.reject("download start failed: " + e);
    }
  }

  @PluginMethod
  public void status(PluginCall call) {
    JSObject r = new JSObject();
    File f = targetFile();
    r.put("fileExists", f.exists());
    r.put("fileSize", f.exists() ? f.length() : 0);
    r.put("done", false);
    r.put("failed", false);
    try {
      if (taskId >= 0) {
        DownloadManager dm = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
        DownloadManager.Query q = new DownloadManager.Query().setFilterById(taskId);
        try (Cursor c = dm.query(q)) {
          if (c != null && c.moveToFirst()) {
            int status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            if (status == DownloadManager.STATUS_SUCCESSFUL) {
              r.put("done", true);
            } else if (status == DownloadManager.STATUS_FAILED) {
              r.put("done", true);
              r.put("failed", true);
            }
          }
        }
      }
    } catch (Exception ignored) {
    }
    if (taskId < 0 && f.exists() && f.length() > 0) {
      r.put("done", true);
    }
    call.resolve(r);
  }

  @PluginMethod
  public void install(PluginCall call) {
    File f = targetFile();
    if (!f.exists()) {
      call.reject("apk not downloaded");
      return;
    }
    try {
      Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
      Intent intent = new Intent(Intent.ACTION_VIEW);
      intent.setDataAndType(uri, "application/vnd.android.package-archive");
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
      getActivity().startActivity(intent);
      call.resolve();
    } catch (Exception e) {
      call.reject("install failed: " + e);
    }
  }
}

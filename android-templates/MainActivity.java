package cz.mytube.feed;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Bundle;
import android.os.Parcelable;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView webView = getBridge().getWebView();
        if (webView != null) {
            webView.addJavascriptInterface(new AndroidBridge(), "AndroidBridge");
        }
        handleSendIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleSendIntent(intent);
    }

    private void handleSendIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        String type = intent.getType();
        if (Intent.ACTION_SEND.equals(action) && "text/plain".equals(type)) {
            final String sharedText = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (sharedText != null && getBridge() != null && getBridge().getWebView() != null) {
                final String escaped = JSONObject.quote(sharedText);
                getBridge().getWebView().postDelayed(() -> {
                    getBridge().getWebView().evaluateJavascript(
                        "if (window.onAndroidSharedUrl) window.onAndroidSharedUrl(" + escaped + ");",
                        null
                    );
                }, 600);
            }
        }
    }

    public class AndroidBridge {

        @JavascriptInterface
        public String getInstalledBrowsers() {
            JSONArray arr = new JSONArray();
            try {
                PackageManager pm = getPackageManager();
                Map<String, String> found = new LinkedHashMap<>();

                // 1) Dotaz na obecné webové prohlížeče (http://example.com)
                Intent browserIntent = new Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com"));
                List<ResolveInfo> browsers = pm.queryIntentActivities(browserIntent, PackageManager.MATCH_ALL);
                for (ResolveInfo info : browsers) {
                    String pkg = info.activityInfo.packageName;
                    if (!pkg.equals(getPackageName())) {
                        String label = info.loadLabel(pm).toString();
                        found.put(pkg, label);
                    }
                }

                // 2) Dotaz na přehrávače YouTube odkazů (NewPipe, PipePipe, Grayjay, LibreTube...)
                Intent ytIntent = new Intent(Intent.ACTION_VIEW, Uri.parse("https://www.youtube.com/watch?v=dQw4w9WgXcQ"));
                List<ResolveInfo> ytApps = pm.queryIntentActivities(ytIntent, PackageManager.MATCH_ALL);
                for (ResolveInfo info : ytApps) {
                    String pkg = info.activityInfo.packageName;
                    if (!pkg.equals(getPackageName()) && !found.containsKey(pkg)) {
                        String label = info.loadLabel(pm).toString();
                        found.put(pkg, label);
                    }
                }

                for (Map.Entry<String, String> entry : found.entrySet()) {
                    JSONObject obj = new JSONObject();
                    obj.put("packageName", entry.getKey());
                    obj.put("label", entry.getValue());
                    arr.put(obj);
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
            return arr.toString();
        }

        @JavascriptInterface
        public boolean openUrl(String url, String targetPackage) {
            try {
                Uri uri = Uri.parse(url);
                PackageManager pm = getPackageManager();

                // Pokud je zvolen konkrétní prohlížeč (např. com.brave.browser nebo org.mozilla.firefox)
                if (targetPackage != null && !targetPackage.isEmpty()
                        && !"chooser".equals(targetPackage) && !"default".equals(targetPackage)) {
                    Intent direct = new Intent(Intent.ACTION_VIEW, uri);
                    direct.setPackage(targetPackage);
                    direct.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    if (direct.resolveActivity(pm) != null) {
                        startActivity(direct);
                        return true;
                    }
                }

                // Jinak sestavit vlastní Chooser ze všech nainstalovaných prohlížečů a přehrávačů
                Intent probe = new Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com"));
                List<ResolveInfo> browsers = pm.queryIntentActivities(probe, PackageManager.MATCH_ALL);
                List<Intent> targetIntents = new ArrayList<>();

                for (ResolveInfo info : browsers) {
                    String pkg = info.activityInfo.packageName;
                    if (pkg.equals(getPackageName())) continue;
                    Intent i = new Intent(Intent.ACTION_VIEW, uri);
                    i.setPackage(pkg);
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    targetIntents.add(i);
                }

                if (!targetIntents.isEmpty()) {
                    Intent primary = targetIntents.remove(0);
                    Intent chooser = Intent.createChooser(primary, "Otevřít video v prohlížeči");
                    chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, targetIntents.toArray(new Parcelable[0]));
                    chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(chooser);
                    return true;
                }

                // Fallback na standardní systémový Intent
                Intent fallback = new Intent(Intent.ACTION_VIEW, uri);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(fallback);
                return true;
            } catch (Exception e) {
                e.printStackTrace();
                return false;
            }
        }
    }
}

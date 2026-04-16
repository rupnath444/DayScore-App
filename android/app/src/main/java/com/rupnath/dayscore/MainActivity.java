package com.rupnath.dayscore;

import android.app.AlarmManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;
import com.getcapacitor.BridgeActivity;
import com.rupnath.dayscore.reminders.DayScoreReminderPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(DayScoreReminderPlugin.class);
        super.onCreate(savedInstanceState);
        // Enable DOM storage so Firebase Auth redirect works
        WebView webView = getBridge().getWebView();
        WebSettings settings = webView.getSettings();
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setJavaScriptEnabled(true);
        ensureBackgroundNotificationAccess();
    }

    private void ensureBackgroundNotificationAccess() {
        String packageName = getPackageName();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AlarmManager alarmManager = (AlarmManager) getSystemService(ALARM_SERVICE);
            if (alarmManager != null && !alarmManager.canScheduleExactAlarms()) {
                Toast.makeText(this, "Allow exact alarms for DayScore", Toast.LENGTH_LONG).show();
                Intent exactAlarmIntent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
                exactAlarmIntent.setData(Uri.parse("package:" + packageName));
                exactAlarmIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    startActivity(exactAlarmIntent);
                } catch (Exception ignored) {
                    Intent appDetailsIntent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                    appDetailsIntent.setData(Uri.parse("package:" + packageName));
                    appDetailsIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(appDetailsIntent);
                }
            }
        }

    }
}
package com.rupnath.dayscore.reminders;

import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.rupnath.dayscore.MainActivity;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public final class DayScoreReminderScheduler {
    public static final String CHANNEL_ID = "dayscore-reminders-v2";
    private static final String PREFS_NAME = "dayscore_native_reminders";
    private static final String PREFS_KEY = "scheduled_reminders";

    private DayScoreReminderScheduler() {}

    public static final class ReminderRecord {
        public final int id;
        public final String title;
        public final String body;
        public final long at;
        public final String taskKey;
        public final long taskId;

        public ReminderRecord(int id, String title, String body, long at, String taskKey, long taskId) {
            this.id = id;
            this.title = title;
            this.body = body;
            this.at = at;
            this.taskKey = taskKey;
            this.taskId = taskId;
        }

        public JSONObject toJson() throws JSONException {
            JSONObject json = new JSONObject();
            json.put("id", id);
            json.put("title", title);
            json.put("body", body);
            json.put("at", at);
            json.put("taskKey", taskKey);
            json.put("taskId", taskId);
            return json;
        }

        public static ReminderRecord fromJson(JSONObject json) throws JSONException {
            return new ReminderRecord(
                json.getInt("id"),
                json.optString("title", "DayScore - Task Due"),
                json.optString("body", "Task due now"),
                json.getLong("at"),
                json.optString("taskKey", ""),
                json.optLong("taskId", 0L)
            );
        }
    }

    public static void sync(Context context, List<ReminderRecord> reminders) {
        List<ReminderRecord> upcoming = filterUpcoming(reminders);
        cancelAll(context);
        save(context, upcoming);
        for (ReminderRecord reminder : upcoming) {
            scheduleOne(context, reminder);
        }
    }

    public static void restore(Context context) {
        List<ReminderRecord> upcoming = filterUpcoming(load(context));
        save(context, upcoming);
        scheduleAll(context, upcoming);
    }

    public static void clear(Context context) {
        cancelAll(context);
        prefs(context).edit().remove(PREFS_KEY).apply();
    }

    public static JSONArray pending(Context context) {
        JSONArray array = new JSONArray();
        for (ReminderRecord reminder : filterUpcoming(load(context))) {
            try {
                array.put(reminder.toJson());
            } catch (JSONException ignored) {}
        }
        return array;
    }

    private static void scheduleAll(Context context, List<ReminderRecord> reminders) {
        for (ReminderRecord reminder : reminders) {
            scheduleOne(context, reminder);
        }
    }

    private static void scheduleOne(Context context, ReminderRecord reminder) {
        AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) return;

        long triggerAt = reminder.at;
        if (triggerAt <= System.currentTimeMillis()) return;

        Intent intent = new Intent(context, DayScoreReminderReceiver.class);
        intent.putExtra("id", reminder.id);
        intent.putExtra("title", reminder.title);
        intent.putExtra("body", reminder.body);
        intent.putExtra("taskKey", reminder.taskKey);
        intent.putExtra("taskId", reminder.taskId);
        intent.putExtra("at", triggerAt);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pendingIntent = PendingIntent.getBroadcast(context, reminder.id, intent, flags);

        Intent launchIntent = new Intent(context, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent showIntent = PendingIntent.getActivity(context, reminder.id, launchIntent, flags);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !alarmManager.canScheduleExactAlarms()) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                alarmManager.setAlarmClock(new AlarmManager.AlarmClockInfo(triggerAt, showIntent), pendingIntent);
            } else {
                alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent);
            }
        } else {
            alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent);
        }
    }

    private static void cancelAll(Context context) {
        AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) return;
        for (ReminderRecord reminder : load(context)) {
            Intent intent = new Intent(context, DayScoreReminderReceiver.class);
            int flags = 0;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                flags |= PendingIntent.FLAG_IMMUTABLE;
            }
            PendingIntent pendingIntent = PendingIntent.getBroadcast(context, reminder.id, intent, flags);
            alarmManager.cancel(pendingIntent);
            pendingIntent.cancel();
        }
    }

    private static void save(Context context, List<ReminderRecord> reminders) {
        JSONArray array = new JSONArray();
        for (ReminderRecord reminder : reminders) {
            try {
                array.put(reminder.toJson());
            } catch (JSONException ignored) {}
        }
        prefs(context).edit().putString(PREFS_KEY, array.toString()).apply();
    }

    private static List<ReminderRecord> load(Context context) {
        List<ReminderRecord> reminders = new ArrayList<>();
        String raw = prefs(context).getString(PREFS_KEY, "[]");
        try {
            JSONArray array = new JSONArray(raw);
            for (int i = 0; i < array.length(); i++) {
                JSONObject json = array.getJSONObject(i);
                reminders.add(ReminderRecord.fromJson(json));
            }
        } catch (JSONException ignored) {}
        return reminders;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private static List<ReminderRecord> filterUpcoming(List<ReminderRecord> reminders) {
        long now = System.currentTimeMillis();
        List<ReminderRecord> upcoming = new ArrayList<>();
        for (ReminderRecord reminder : reminders) {
            if (reminder != null && reminder.at > now) {
                upcoming.add(reminder);
            }
        }
        return upcoming;
    }

    public static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel channel = manager.getNotificationChannel(CHANNEL_ID);
        if (channel == null) {
            channel = new NotificationChannel(CHANNEL_ID, "DayScore Reminders", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("Task due reminders");
            channel.enableVibration(true);
            manager.createNotificationChannel(channel);
        }
    }

    public static void showNotification(Context context, Intent intent) {
        ensureChannel(context);
        int id = intent.getIntExtra("id", 0);
        String title = intent.getStringExtra("title");
        String body = intent.getStringExtra("body");
        long taskId = intent.getLongExtra("taskId", 0L);
        String taskKey = intent.getStringExtra("taskKey");

        Intent launchIntent = new Intent(context, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        launchIntent.putExtra("fromReminder", true);
        launchIntent.putExtra("taskKey", taskKey);
        launchIntent.putExtra("taskId", taskId);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent contentIntent = PendingIntent.getActivity(context, id, launchIntent, flags);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(context.getApplicationInfo().icon)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(contentIntent)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setDefaults(android.app.Notification.DEFAULT_ALL);

        NotificationManagerCompat.from(context).notify(id, builder.build());
    }
}
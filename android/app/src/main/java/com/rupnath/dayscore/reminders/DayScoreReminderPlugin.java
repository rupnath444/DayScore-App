package com.rupnath.dayscore.reminders;

import android.content.Context;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

@CapacitorPlugin(name = "DayScoreReminder")
public class DayScoreReminderPlugin extends Plugin {
    @PluginMethod
    public void sync(PluginCall call) {
        JSArray notifications = call.getArray("notifications");
        List<DayScoreReminderScheduler.ReminderRecord> reminders = new ArrayList<>();
        if (notifications != null) {
            for (int i = 0; i < notifications.length(); i++) {
                try {
                    JSONObject object = notifications.getJSONObject(i);
                    reminders.add(
                        new DayScoreReminderScheduler.ReminderRecord(
                            object.getInt("id"),
                            object.optString("title", "DayScore - Task Due"),
                            object.optString("body", "Task due now"),
                            object.getLong("at"),
                            object.optString("taskKey", ""),
                            object.optLong("taskId", 0L)
                        )
                    );
                } catch (Exception ignored) {}
            }
        }

        Context context = getContext();
        DayScoreReminderScheduler.ensureChannel(context);
        DayScoreReminderScheduler.sync(context, reminders);

        JSObject result = new JSObject();
        result.put("count", reminders.size());
        call.resolve(result);
    }

    @PluginMethod
    public void clear(PluginCall call) {
        DayScoreReminderScheduler.clear(getContext());
        call.resolve();
    }

    @PluginMethod
    public void getPending(PluginCall call) {
        JSObject result = new JSObject();
        result.put("notifications", DayScoreReminderScheduler.pending(getContext()));
        call.resolve(result);
    }
}
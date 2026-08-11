import { Tabs } from 'expo-router';
import { colors } from '@/theme';
import { NavShell } from '@/components/organisms';

export const unstable_settings = {
  initialRouteName: 'index',
};

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <NavShell {...props} />}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: colors.bgDeepSpace },
      }}
    >
      <Tabs.Screen name="race-week" options={{ title: 'Race Week' }} />
      <Tabs.Screen name="index" options={{ title: 'Manager' }} />
      <Tabs.Screen name="league" options={{ title: 'League' }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile' }} />
    </Tabs>
  );
}

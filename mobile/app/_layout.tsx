import '../global.css';
import { useEffect, useState } from 'react';
import { LogBox, Platform, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Stack } from 'expo-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { useFonts, BarlowCondensed_700Bold, BarlowCondensed_800ExtraBold } from '@expo-google-fonts/barlow-condensed';
import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold } from '@expo-google-fonts/inter';
import { JetBrainsMono_700Bold } from '@expo-google-fonts/jetbrains-mono';
import { colors } from '@/theme';
import { queryClient } from '@/lib/queryClient';

// Third-party deprecation notices we cannot act on; keep the dev overlay for real problems.
LogBox.ignoreLogs(['InteractionManager has been deprecated', '[react-native-skia] SkPath']);

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    BarlowCondensed_700Bold,
    BarlowCondensed_800ExtraBold,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    JetBrainsMono_700Bold,
  });

  /**
   * On web, Skia runs on CanvasKit, which has to be fetched before any Skia
   * drawing happens; the wasm is served from `public/canvaskit.wasm`. Native
   * has Skia compiled in, so it starts ready.
   *
   * NOTE: this alone is not enough for the web target. Screens that import
   * Skia statically evaluate their module — and bind `Skia` — before this
   * resolves, so they still see an uninitialised CanvasKit. Finishing web
   * support means loading those screens through Skia's `WithSkiaWeb` lazy
   * wrapper. Web is not a shipping target today; iOS/Android are unaffected.
   */
  const [skiaReady, setSkiaReady] = useState(Platform.OS !== 'web');
  useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }
    let cancelled = false;
    import('@shopify/react-native-skia/lib/module/web')
      .then(({ LoadSkiaWeb }) => LoadSkiaWeb())
      .then(() => {
        if (!cancelled) {
          setSkiaReady(true);
        }
      })
      .catch((error) => {
        console.error('CanvasKit failed to load; Skia views will not render.', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!fontsLoaded || !skiaReady) {
    return <View style={styles.root} />;
  }

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <View style={styles.root}>
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.bgDeepSpace },
                animation: 'fade',
              }}
            />
            <StatusBar style="light" />
          </View>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bgDeepSpace,
  },
});

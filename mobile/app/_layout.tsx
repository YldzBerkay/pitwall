import '../global.css';
import { useEffect, useState } from 'react';
import { LogBox, StyleSheet, View } from 'react-native';
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
import { ProgressLoader } from '@/components/atoms';

const LOADING_TIPS = [
  'Pit duvarı: pit çağrısı sıraya alındıktan sonraki turda uygulanır.',
  'Lastik aşınması %95 üstüne çıkınca kırmızıya döner — o turda pite girmeyi düşünün.',
  'Mühendis brifingindeki öneriyi tutmak +8 RP ve +5 skor kazandırır.',
  'Sarı bayrakta geçiş zorlaşır, güvenlik aracında pit kaybı yarıya iner.',
];

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

  // Real progress from font loading — never a decoy animation. Shown only
  // past a short grace window so a sub-second native boot never flashes it.
  // Once fonts finish this branch stops rendering for good, so there is
  // nothing to reset `showLoader` back to.
  const [showLoader, setShowLoader] = useState(false);
  useEffect(() => {
    if (fontsLoaded) return;
    const id = setTimeout(() => setShowLoader(true), 400);
    return () => clearTimeout(id);
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    return (
      <View style={[styles.root, styles.loadingCenter]}>
        {showLoader && <ProgressLoader value={10} tips={LOADING_TIPS} label="Pit Wall hazırlanıyor" />}
      </View>
    );
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
  loadingCenter: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
});

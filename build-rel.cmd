@echo off
set JAVA_HOME=C:\Program Files\Android\Android Studio\jbr
set PATH=%JAVA_HOME%\bin;%PATH%
echo JAVA_HOME: %JAVA_HOME%
java -version 2>&1
echo ---
gradlew assembleRelease --console=plain
echo EXIT_CODE=%ERRORLEVEL%
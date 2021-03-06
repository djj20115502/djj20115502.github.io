---
layout: default
---
# gradle学习笔记

# Gradle生命周期
如下基本配置
```
root-project/
   sub-project1/
      build.gradle
   sub-project2/
      build.gradle
build.gradle
settings.gradle
gradle.properties
local.properties
```
> Gradle构建系统有自己的生命周期，初始化、配置和运行三个阶段。

1. **初始化阶段**，会去读取根工程中setting.gradle中的include信息，决定有哪几个工程加入构建，比如上面有2个工程： include ‘: sub-project1’, ‘: sub-project2’, 

2. **配置阶段**，解析每个project中的build.gradle脚本，配置project对象，一个对象由多个任务组成，此阶段也会去创建、配置task及相关信息。配置阶段完成后，整个build的project以及内部的Task关系就确定了。

3. **运行阶段**，根据gradle命令传递过来的task名称，执行相关依赖任务
![image](http://img.blog.csdn.net/20170601175903551?watermark/2/text/aHR0cDovL2Jsb2cuY3Nkbi5uZXQvenhjMTIzZQ==/font/5a6L5L2T/fontsize/400/fill/I0JBQkFCMA==/dissolve/70/gravity/SouthEast)




#  Project、Task、Action的关系
> 主要是基于一个个的task，plugin也就是基于一系列的task

每个项目的编译至少有一个 Project,一个 build.gradle就代表一个project,每个project里面包含了多个task,task 里面又包含很多action，action是一个代码块，里面包含了需要被执行的代码。


例如下面，我们需要一个android应用程序，这里就需要引入相关的插件“com.android.application”,然后根据插件定义好的格式来完成其中的配置项的填写。
```
apply plugin: 'com.android.application'

android {.....}
```
# 具体分析
## 根目录的build.gradle
  
```
// apply from: "config.gradle"
buildscript {
    repositories {
        jcenter()
    }
    dependencies {

        classpath 'com.android.tools.build:gradle:2.3.0'

        // NOTE: Do not place your application dependencies here; they belong
        // in the individual module build.gradle files
    }
}

allprojects {
    repositories {
        jcenter()
    }
}

task clean(type: Delete) {
    delete rootProject.buildDir
}
```
这个文件主要是完成主要的配置工作。
buildscript 主要是用来设置构建工具的相关的版本设置

allprojects 是用来统一添加项目依赖

这里的第一行的“apply form”也是引入一个插件，但这里主要是为了方便项目中一些修改项的统一管理。

根目录下的“config.gradle”
```


ext {
    android = [ 
               buildToolsVersion: "25.0.0",
               targetSdkVersion : 21,
     ]
}
```
子目录下的build.gradle中来引用
```
...
def dep = rootProject.ext.android // 依赖
 defaultConfig {
    ...
        targetSdkVersion config.targetSdkVersion
    ...
    }
...
```
同时，设置在gradle.properties也可以达到相同的效果

建议这个文件作为本地差异配置，无需上传 例如 签名地址什么的可以考虑设置在项目跟文件夹中的
“gradle.properties”中
```
#  gradle.properties文件中
DEBUG_STORE_FILE=C:/.../debug.keystore
KEY_PASSWORD=android

# build.gradle中直接引用就行
storeFile file(DEBUG_STORE_FILE)
keyPassword KEY_PASSWORD

```
## 模块build.gradle文件


```

import java.text.SimpleDateFormat

apply plugin: 'com.android.library'

android {
...
}

def dep = rootProject.ext.dependencies // 依赖
dependencies {
    compile fileTree(include: ['*.jar'], dir: 'libs')
    compile dep.support_v7
 ...
}


task makeJar(type: Copy) {
    ...
}

```
1. **import** 跟java一样，如果需要引用了其他包的方法则需要引入
2. **apply** 声明一个引用的插件，例如这里声明了该模块是一个包项目。
3. **android** 这个是根据声明的插件而来的一些必要的配置项，如果声明引用的插件没有什么必要的配置项，这里也就没有了。
4. **dependencies**项目的相关依赖，依赖的jar包，或者工程
5. **task**额外自己根据需要定义的其他的一些任务。非必需 

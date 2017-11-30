---
title: android cpu占用分析  
icon: https://ss1.bdstatic.com/70cFuXSh_Q1YnxGkpoWK1HF6hhy/it/u=453424286,202850325&fm=11&gp=0.jpg 
intro: 通过命令行分析  
layout: blog
---

[Linux处理](http://blog.csdn.net/zgs_shmily/article/details/51019933)

这里用到的命令都是top和ps，但是由于android有部分不同，这里

# 1 通过top命令查看是那一个线程占用CPU
android 中的top命令可用的地方比较少

```
Usage: top [ -m max_procs ] [ -n iterations ] [ -d delay ] [ -s sort_column ] [ -t ] [ -h ]
    -m num  Maximum number of processes to display.
    -n num  Updates to show before exiting.
    -d num  Seconds to wait between updates.        
    -s col  Column to sort by (cpu,vss,rss,thr).
    -t      Show threads instead of processes.
    -h      Display this help screen.
-m： 显示的最多进程数，做优化时一般只关心CPU占用率最高的几个进程，
那么只需要top -m 3或top -m 5就好了，以免top命令的输出太多

-n：显示n次top的结果后命令就会退出

-d：更新的时间间隔，默认是每隔3s更新下状态，
    top -d 0时会持续地输出，不过很占CPU。

-s：选择根据某项（cpu,vss,rss,thr）来排序

-t： 显示线程而非进程

-h：显示帮助信息
```

例如看launcher的线程CPU使用情况
top -s cpu -t |grep com.konka.livelauncher

# 2 通过堆栈信息来查看具体操作的地方
[android堆栈查看](http://blog.csdn.net/freshui/article/details/9456889)

这里也是跟Linux有点差异，由于没有jstack命令这里只能用其他的来代替。

```
kill -3 pid
```
输出的trace会保存在 /data/anr/traces.txt文件中。这个需要注意，如果没有 /data/anr/这个目录或/data/anr/traces.txt这个文件，需要手工创建一下，并设置好读写权限。 

# 3 第三方工具
DDMS或者是android studio中的cpu monitor来查看
[链接](http://www.jianshu.com/p/6bf564f7cdf0)